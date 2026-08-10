// netlify/functions/mbs-webhook.js
// Webhook Stripe : appele par Stripe quand un paiement d'acompte est confirme.
// Verifie la signature (STRIPE_WEBHOOK_SECRET), puis enregistre la reservation
// confirmee dans le CRM (client + seance + paiement, brand "mybabyshoot"),
// libere le verrou, notifie Matt et envoie l'email de confirmation au client.
import Stripe from "stripe";
import { crmStore, loadData, pruneLocks, uid, typeLabelFr, PLACE, BRAND } from "../mbs-lib.mjs";
import { notifyAll } from "../push-lib.mjs";
import { sendMail } from "../mbs-mail.mjs";
import { makeInvoicePdf, nextInvoiceNumber } from "../mbs-invoice.mjs";
import { couponStore, consumeCoupon, prettyCode, prettyGift, createGiftCoupon, frDateShort } from "../mbs-coupons.mjs";

const SEANCE_TXT = {
  grossesse: "Séance grossesse",
  naissance: "Séance naissance",
  duo:       "Grossesse et naissance"
};

/* Hotes autorises dans les liens envoyes par email. L'origine vient du
   navigateur de l'acheteur : on ne la suit que si elle est dans cette liste,
   pour qu'une requete forgee ne puisse pas glisser son propre lien. */
const SITES_OK = [
  "mybabyshoot.fr",
  "www.mybabyshoot.fr",
  "sparkly-stroopwafel-d583f1.netlify.app"
];

/* Le site qui sert reellement les pages publiques (bon.html notamment).
   Ordre : le site utilise pour l'achat, puis la variable Netlify, puis
   le site en ligne aujourd'hui. A la migration Wix, mybabyshoot.fr prendra
   le relais tout seul puisque l'achat s'y fera. */
function siteClient(md) {
  for (const c of [md && md.site, process.env.MBS_SITE_URL]) {
    if (!c) continue;
    try {
      const u = new URL(String(c));
      if (SITES_OK.includes(u.host)) return u.origin;
    } catch (e) { /* valeur inutilisable, on passe a la suivante */ }
  }
  return "https://sparkly-stroopwafel-d583f1.netlify.app";
}

function frDate(iso){
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

async function sendClientEmail(m){
  if (!m.email) return;
  const reste = Math.max(0, Number(m.total) - Number(m.acompte));
  const html =
    "<p>Bonjour " + (m.prenom || "") + ",</p>" +
    "<p>Votre réservation est confirmée. Merci, et à très vite au studio.</p>" +
    "<ul>" +
    "<li><b>Séance :</b> " + typeLabelFr(m.type) + "</li>" +
    "<li><b>Date :</b> " + frDate(m.date) + " à " + m.time + "</li>" +
    "<li><b>Lieu :</b> " + PLACE + "</li>" +
    "<li><b>Acompte réglé :</b> " + m.acompte + " €</li>" +
    "<li><b>Solde le jour de la séance :</b> " + reste + " €</li>" +
    "</ul>" +
    (m.invPdf ? "<p>Votre facture d'acompte est en pièce jointe.</p>" : "") +
    "<p>Une question ? Répondez à cet email ou appelez le 06 47 76 54 17.</p>" +
    "<p>Mybabyshoot</p>";
  const attachments = m.invPdf
    ? [{ filename: "Facture-" + (m.invNum || "acompte") + ".pdf", content: m.invPdf, contentType: "application/pdf" }]
    : [];
  await sendMail({
    to: m.email,
    subject: "Votre réservation est confirmée · Mybabyshoot",
    html, attachments
  });
}

/* Bon cadeau paye : on cree le code, on l'envoie a l'acheteur (bon a imprimer
   ou a transferer), on previent Matt et on trace l'encaissement dans le CRM. */
async function traiterBonCadeau(session, md) {
  const store = crmStore();
  const data  = await loadData(store);
  const now   = Date.now();

  // idempotence : un seul bon par session Stripe
  if ((data.paiements || []).some(p => p.stripeSession === session.id))
    return;

  const montant = Number(md.montant) || Math.round((session.amount_total || 0) / 100);
  const prenom  = md.prenom || "";
  const nom     = md.nom || "";
  const email   = (md.email || session.customer_email || "").trim();
  const tel     = (md.tel || "").trim();
  const name    = [prenom, nom].filter(Boolean).join(" ").trim() || "Acheteur bon cadeau";

  const coupon = await createGiftCoupon(couponStore(), {
    amount: montant,
    formule: md.label || "",
    seance: md.seance || "grossesse",
    acheteur: { nom: name, email, tel },
    beneficiaire: md.pour || "",
    message: md.mot || "",
    sessionId: session.id, now
  });
  if (!coupon) throw new Error("code_non_cree");

  // Fiche acheteur dans le CRM (c'est un contact, pas encore une seance).
  let client = data.clients.find(c =>
    c.brand === BRAND &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g, "") === tel.replace(/\s/g, "")))
  );
  const ligne = "Bon cadeau " + prettyGift(coupon.code) + " · " + (md.label || "") + " " + SEANCE_TXT[coupon.seance]
    + " · " + montant + " € acheté le " + new Date(now).toLocaleDateString("fr-FR")
    + (md.pour ? " pour " + md.pour : "") + ". Valable jusqu'au " + frDateShort(coupon.expiresAt) + ".";
  if (!client) {
    client = {
      id: uid(), brand: BRAND, name, status: "Prospect", type: "Bon cadeau",
      tel, email, insta: "", source: "Bon cadeau", notes: ligne,
      fromSite: true, createdAt: now
    };
    data.clients.push(client);
  } else {
    client.notes = (client.notes ? client.notes + "\n" : "") + ligne;
  }

  data.paiements.push({
    id: uid(), brand: BRAND, clientId: client.id,
    label: "Bon cadeau " + prettyGift(coupon.code),
    total: String(montant), acompte: String(montant), statut: "Solde",
    date: new Date(now).toISOString().slice(0, 10), dueDate: "",
    notes: "Encaissé en ligne via Stripe. " + ligne,
    stripeSession: session.id
  });

  data.t = now;
  await store.setJSON("data", data);

  try {
    await notifyAll(
      "Bon cadeau vendu",
      name + " · " + montant + " €" + (md.pour ? " pour " + md.pour : ""),
      "/"
    );
  } catch (e) {}

  if (email) {
    const site = siteClient(md);
    const lien = site + "/bon.html?code=" + coupon.code;
    const html =
      "<p>Bonjour " + prenom + ",</p>" +
      "<p>Merci beaucoup. Voici le bon cadeau" + (md.pour ? " pour " + md.pour : "") + ", prêt à être offert.</p>" +
      "<p style=\"margin:22px 0\"><a href=\"" + lien + "\" style=\"background:#5E4430;color:#FAF4EA;padding:14px 26px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold\">Voir et imprimer le bon cadeau</a></p>" +
      "<p>Ce lien ouvre votre bon en grand : vous pouvez le <b>télécharger en image</b> pour l'imprimer et l'offrir en main propre, ou simplement transmettre le code.</p>" +
      "<div style=\"border:2px solid #5E4430;border-radius:16px;padding:24px;text-align:center;font-family:Georgia,serif;max-width:420px\">" +
        "<div style=\"letter-spacing:3px;font-size:12px;color:#8a7a6a\">MYBABYSHOOT</div>" +
        "<div style=\"font-size:22px;margin:10px 0 4px\">Bon cadeau</div>" +
        "<div style=\"font-size:18px;font-weight:bold\">" + (md.label || "") + "</div>" +
        "<div style=\"font-size:15px;color:#8a7a6a;margin-bottom:14px\">" + SEANCE_TXT[coupon.seance] + "</div>" +
        (md.pour ? "<div style=\"margin-top:8px\">Pour " + md.pour + "</div>" : "") +
        (md.mot ? "<div style=\"margin-top:8px;font-style:italic\">" + md.mot + "</div>" : "") +
        "<div style=\"margin:18px 0 4px;font-size:12px;color:#8a7a6a\">CODE À UTILISER</div>" +
        "<div style=\"font-size:26px;letter-spacing:4px;font-weight:bold\">" + prettyGift(coupon.code) + "</div>" +
        "<div style=\"margin-top:14px;font-size:12px;color:#8a7a6a\">Valable jusqu'au " + frDateShort(coupon.expiresAt) + "</div>" +
      "</div>" +
      // Le montant reste hors du bon : celui qui le recoit n'a pas a decouvrir
      // le prix du cadeau, meme si l'email lui est transfere.
      "<p style=\"font-size:13px;color:#888\">Montant réglé : " + montant + " €. Le prix n'apparaît nulle part sur le bon.</p>" +
      "<p style=\"margin-top:18px\">Comment l'utiliser : rendez-vous sur <a href=\"" + site + "/#composer\">" + site.replace(/^https?:\/\//, "") + "</a>, "
      + "choisissez la date et le créneau, puis saisissez le code au moment de la réservation. La séance est déjà réglée, il n'y aura rien à payer.</p>" +
      "<p>Ce bon est à usage unique : gardez le code précieusement.</p>" +
      "<p>Une question ? Répondez à cet email ou appelez le 06 47 76 54 17.</p>" +
      "<p>À très vite,<br>Matteo · Mybabyshoot</p>";
    await sendMail({ to: email, subject: "Votre bon cadeau Mybabyshoot", html });
  }
}

/* Reservation commencee mais jamais payee : on cree un prospect dans le CRM,
   on previent Matt, et on envoie un email doux avec le lien pour reprendre. */
async function traiterAbandon(session, md) {
  const store = crmStore();
  const data  = await loadData(store);
  const now   = Date.now();

  // idempotence : une seule relance par session Stripe
  if ((data.clients || []).some(c => c.abandonSession === session.id)) return;

  const prenom = md.prenom || "";
  const nom    = md.nom || "";
  const email  = (md.email || session.customer_email || "").trim();
  const tel    = md.tel || "";
  const typeLbl = typeLabelFr(md.type || "grossesse");
  const nomComplet = [prenom, nom].filter(Boolean).join(" ").trim() || "Prospect";
  const ligne = "Réservation commencée le " + new Date(now).toLocaleDateString("fr-FR")
    + " (" + typeLbl + " le " + frDate(md.date) + " à " + md.time + ", " + (md.total || "?") + " €) mais paiement non finalisé.";

  // fiche existante (meme email ou meme telephone) sinon nouveau prospect
  const dup = (data.clients || []).find(c =>
    c.brand === BRAND &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g, "") === tel.replace(/\s/g, ""))));

  if (dup) {
    dup.notes = (dup.notes ? dup.notes + "\n" : "") + ligne;
    dup.abandonSession = session.id;
    dup.fromSite = true;
  } else {
    data.clients.push({
      id: uid(), brand: BRAND, name: nomComplet, status: "Prospect",
      type: typeLbl, tel, email, insta: "",
      source: "Réservation abandonnée", notes: ligne,
      fromSite: true, abandonSession: session.id, createdAt: now
    });
  }
  data.t = now;
  await store.setJSON("data", data);

  try {
    await notifyAll(
      "Réservation non finalisée",
      nomComplet + " · " + typeLbl + " le " + frDate(md.date) + (tel ? " · " + tel : ""),
      "/"
    );
  } catch (e) {}

  // email doux au prospect (uniquement s'il a laisse son email)
  if (email) {
    const site = siteClient(md);
    const html =
      "<p>Bonjour " + (prenom || "") + ",</p>" +
      "<p>Vous avez commencé à réserver une <b>séance " + typeLbl.toLowerCase() + "</b> au studio, et la réservation n'est pas allée au bout. Aucun souci : votre créneau a simplement été libéré.</p>" +
      "<p>Si vous souhaitez toujours venir, tout est encore possible :</p>" +
      "<p><a href=\"" + site + "/#composer\" style=\"background:#5E4430;color:#FAF4EA;padding:12px 22px;border-radius:999px;text-decoration:none;display:inline-block\">Choisir une nouvelle date</a></p>" +
      "<p>Et si vous avez la moindre question (déroulement, tenues, meilleur moment pour la séance), répondez simplement à cet email ou appelez-moi au <b>06 47 76 54 17</b>. Je réponds toujours avec plaisir.</p>" +
      "<p>À très vite,<br>Matteo · Mybabyshoot</p>" +
      "<p style=\"font-size:12px;color:#888\">Vous recevez ce message car une réservation a été commencée avec cette adresse. Si ce n'était pas vous, ignorez simplement cet email.</p>";
    try {
      await sendMail({
        to: email,
        subject: "Votre réservation au studio est restée en attente",
        html
      });
    } catch (e) {}
  }
}

export default async (request) => {
  if (request.method !== "POST") return new Response("method", { status: 405 });

  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) return new Response("not configured", { status: 503 });

  const sig = request.headers.get("stripe-signature") || "";
  const raw = await request.text(); // corps brut indispensable pour la verification

  let event;
  try {
    const stripe = new Stripe(secret);
    event = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    return new Response("signature invalide", { status: 400 });
  }

  const estAbandon = event.type === "checkout.session.expired";
  if (event.type !== "checkout.session.completed" && !estAbandon)
    return new Response(JSON.stringify({ received: true, ignored: event.type }), { status: 200 });

  const session = event.data.object;
  const md = session.metadata || {};

  // ---------- Achat d'un bon cadeau ----------
  if (md.app === "mbs-gift") {
    if (estAbandon || session.payment_status !== "paid")
      return new Response(JSON.stringify({ received: true, ignored: "gift_unpaid" }), { status: 200 });
    try { await traiterBonCadeau(session, md); } catch (e) {}
    return new Response(JSON.stringify({ received: true, gift: true }), { status: 200 });
  }

  if (md.app !== "mybabyshoot")
    return new Response(JSON.stringify({ received: true, ignored: "other_app" }), { status: 200 });

  // ---------- Reservation abandonnee : on garde le contact, on relance ----------
  if (estAbandon) {
    try { await traiterAbandon(session, md); } catch (e) {}
    return new Response(JSON.stringify({ received: true, abandon: true }), { status: 200 });
  }
  if (session.payment_status !== "paid")
    return new Response(JSON.stringify({ received: true, unpaid: true }), { status: 200 });

  const store = crmStore();
  const data = await loadData(store);

  // Idempotence : si cette session est deja enregistree, on ne refait rien.
  if (data.seances.some(s => s.stripeSession === session.id) ||
      data.paiements.some(p => p.stripeSession === session.id)) {
    return new Response(JSON.stringify({ received: true, already: true }), { status: 200 });
  }

  const now = Date.now();
  pruneLocks(data, now);

  const type    = md.type || "grossesse";
  const date    = md.date, time = md.time;
  const acompte = Number(md.acompte) || 0;
  const total   = Number(md.total) || acompte;
  const prenom  = md.prenom || "";
  const nom     = md.nom || "";
  const email   = (md.email || "").trim();
  const tel     = (md.tel || "").trim();
  const name    = [prenom, nom].filter(Boolean).join(" ").trim() || "Client Mybabyshoot";
  const typeLbl = typeLabelFr(type);

  // Client : regroupement par email OU telephone (comme crm-lead).
  let client = data.clients.find(c =>
    c.brand === BRAND &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g, "") === tel.replace(/\s/g, "")))
  );
  if (!client) {
    client = {
      id: uid(), brand: BRAND, name, status: "Client", type: typeLbl,
      tel, email, insta: "", source: "Réservation site Mybabyshoot",
      notes: "", fromSite: true, createdAt: now
    };
    data.clients.push(client);
  } else {
    client.tel = client.tel || tel;
    client.email = client.email || email;
    client.status = client.status || "Client";
  }

  // Seance (apparait dans l'agenda du CRM).
  data.seances.push({
    id: uid(), clientId: client.id, brand: BRAND, type: typeLbl,
    date, time, place: PLACE, status: "A venir",
    notes: "Réservation en ligne. Total séance " + total + " €, acompte " + acompte + " € encaissé."
      + (md.coupon ? " Code promo " + prettyCode(md.coupon) + " (-" + md.remise + " €)." : ""),
    createdAt: now, stripeSession: session.id
  });

  // Paiement (acompte encaisse ; le CRM affiche le reste du).
  data.paiements.push({
    id: uid(), brand: BRAND, clientId: client.id,
    label: "Acompte réservation " + typeLbl,
    total: String(total), acompte: String(acompte), statut: "Acompte",
    date: new Date(now).toISOString().slice(0, 10), dueDate: date,
    notes: "Réglé en ligne via Stripe."
      + (md.coupon ? " Code promo " + prettyCode(md.coupon) + " : -" + md.remise + " € (total plein " + md.totalPlein + " €)." : ""),
    stripeSession: session.id
  });

  // Liberation du verrou pose au checkout.
  if (md.lockId) data.mbsLocks = data.mbsLocks.filter(l => l.id !== md.lockId);

  // Le code promo n'est brule qu'ici : paiement confirme, donc usage definitif.
  if (md.coupon) {
    try { await consumeCoupon(couponStore(), md.coupon, session.id, now); } catch (e) {}
  }

  data.t = now;
  await store.setJSON("data", data);

  // Notification push a Matt.
  try {
    await notifyAll(
      "Nouvelle réservation Mybabyshoot",
      name + " · " + typeLbl + " le " + frDate(date) + " à " + time + " · acompte " + acompte + " €",
      "/"
    );
  } catch (e) { /* non bloquant */ }

  // Facture d'acompte (PDF) : numero continu + generation, non bloquant.
  let invNum = null, invPdf = null;
  try {
    invNum = await nextInvoiceNumber();
    invPdf = await makeInvoicePdf({
      number: invNum,
      dateStr: new Date(now).toLocaleDateString("fr-FR"),
      client: { name, email },
      typeLabel: typeLbl,
      seanceDateFr: frDate(date),
      time, acompte, total
    });
  } catch (e) { /* non bloquant : une facture ratee ne doit pas casser la reservation */ }

  // Email de confirmation au client (+ facture jointe, copie a Matt). Best effort.
  await sendClientEmail({ prenom, email, type, date, time, acompte, total, invNum, invPdf });

  return new Response(JSON.stringify({ received: true, booked: true }), { status: 200 });
};

export const config = { path: "/.netlify/functions/mbs-webhook" };
