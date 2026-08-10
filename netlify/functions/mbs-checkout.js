// netlify/functions/mbs-checkout.js
// Cree une session Stripe Checkout pour l'acompte d'une reservation Mybabyshoot.
// Pose d'abord un verrou anti-doublon sur le creneau (un seul client par creneau).
// La cle secrete Stripe est lue dans l'environnement Netlify (STRIPE_SECRET_KEY),
// jamais dans le code.
import Stripe from "stripe";
import {
  crmStore, loadData, pruneLocks, isFree, isValidSlot,
  acompteFor, typeLabelFr, LOCK_TTL_MS, uid, BRAND, PLACE
} from "../mbs-lib.mjs";
import {
  couponStore, checkCoupon, reasonLabel, discountFor,
  reserveCoupon, releaseCoupon, consumeCoupon, prettyGift
} from "../mbs-coupons.mjs";
import { notifyAll } from "../push-lib.mjs";
import { sendMail } from "../mbs-mail.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

function frDate(iso) {
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

/* Bon cadeau couvrant la totalite : il n'y a aucun paiement en ligne, donc pas
   de webhook Stripe. On enregistre nous-memes la reservation dans le CRM,
   on brule le bon, on previent Matt et on confirme au client. */
async function confirmerSansPaiement({ store, lockId, now, md }) {
  const data = await loadData(store);
  pruneLocks(data, now);

  const typeLbl = typeLabelFr(md.type);
  const name = [md.prenom, md.nom].filter(Boolean).join(" ").trim() || "Client Mybabyshoot";
  const email = (md.email || "").trim();
  const tel   = (md.tel || "").trim();

  let client = data.clients.find(c =>
    c.brand === BRAND &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g, "") === tel.replace(/\s/g, "")))
  );
  if (!client) {
    client = {
      id: uid(), brand: BRAND, name, status: "Client", type: typeLbl,
      tel, email, insta: "", source: "Bon cadeau",
      notes: "", fromSite: true, createdAt: now
    };
    data.clients.push(client);
  } else {
    client.tel = client.tel || tel;
    client.email = client.email || email;
    client.status = "Client";
  }

  const detail = "Bon cadeau " + prettyGift(md.coupon) + " (-" + md.remise + " €, séance " + md.totalPlein + " €).";
  data.seances.push({
    id: uid(), clientId: client.id, brand: BRAND, type: typeLbl,
    date: md.date, time: md.time, place: PLACE, status: "A venir",
    notes: "Réservation en ligne réglée avec un bon cadeau. " + detail + " Rien à encaisser le jour J.",
    createdAt: now, giftCode: md.coupon
  });
  data.paiements.push({
    id: uid(), brand: BRAND, clientId: client.id,
    label: "Séance réglée par bon cadeau",
    total: String(md.totalPlein), acompte: String(md.totalPlein), statut: "Solde",
    date: new Date(now).toISOString().slice(0, 10), dueDate: md.date,
    notes: detail + " Déjà payé par l'acheteur du bon.",
    giftCode: md.coupon
  });

  data.mbsLocks = data.mbsLocks.filter(l => l.id !== lockId);
  data.t = now;
  await store.setJSON("data", data);

  // Le bon est brule maintenant : la seance est confirmee.
  try { await consumeCoupon(couponStore(), md.coupon, "cadeau-" + md.date + "-" + md.time, now); } catch (e) {}

  try {
    await notifyAll(
      "Nouvelle réservation (bon cadeau)",
      name + " · " + typeLbl + " le " + frDate(md.date) + " à " + md.time + " · rien à encaisser",
      "/"
    );
  } catch (e) {}

  if (email) {
    const site = md.site || "https://mybabyshoot.fr";
    const html =
      "<p>Bonjour " + (md.prenom || "") + ",</p>" +
      "<p>Votre réservation est confirmée. Merci, et à très vite au studio.</p>" +
      "<ul>" +
      "<li><b>Séance :</b> " + typeLbl + "</li>" +
      "<li><b>Date :</b> " + frDate(md.date) + " à " + md.time + "</li>" +
      "<li><b>Lieu :</b> " + PLACE + "</li>" +
      // Reglee par un bon cadeau : on ne parle ni de reglement ni de solde,
      // la personne n'a rien a payer et n'a pas a revoir le code ici.
      "</ul>" +
      "<p>Une question ? Répondez à cet email ou appelez le 06 47 76 54 17.</p>" +
      "<p>Mybabyshoot · <a href=\"" + site + "\">" + site.replace(/^https?:\/\//, "") + "</a></p>";
    await sendMail({ to: email, subject: "Votre réservation est confirmée · Mybabyshoot", html });
  }
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ ok: false, error: "stripe_not_configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  let   type   = String(body.type || "grossesse");
  const date   = String(body.date || "");
  const time   = String(body.time || "");
  const client = body.client || {};
  const prenom = String(client.prenom || "").trim();
  const nom    = String(client.nom || "").trim();
  const email  = String(client.email || "").trim();
  const tel    = String(client.tel || "").trim();

  if (!isValidSlot(date, time)) return json({ ok: false, error: "invalid_slot" }, 400);
  if (!prenom || !email) return json({ ok: false, error: "missing_client" }, 400);

  // Total de la seance compose par le client (sert a l'acompte et au reste du).
  let total = Math.round(Number(body.total));
  if (!Number.isFinite(total) || total < 90 || total > 5000) total = 290;

  const store = crmStore();
  const now = Date.now();
  let totalPlein = total;

  // Site reellement utilise par le visiteur : sert aux liens des emails et
  // aux retours Stripe. Calcule ici car les deux chemins (paiement, et bon
  // cadeau couvrant toute la seance) en ont besoin.
  const origin = request.headers.get("origin") || "";
  const site = (process.env.MBS_SITE_URL || origin || "https://mybabyshoot.fr").replace(/\/+$/, "");

  // 1) Verrou anti-doublon : on relit, on nettoie les verrous expires, on verifie le creneau.
  const data = await loadData(store);
  pruneLocks(data, now);
  if (!isFree(data, date, time, now)) {
    // Un autre paiement est en cours ou le creneau est deja pris.
    await store.setJSON("data", data); // on persiste au moins le nettoyage des verrous expires
    return json({ ok: false, error: "slot_taken" }, 409);
  }
  const lockId = uid();
  data.mbsLocks.push({ id: lockId, date, time, expiresAt: now + LOCK_TTL_MS });
  await store.setJSON("data", data);

  const releaseLock = async () => {
    try {
      const d2 = await loadData(store);
      d2.mbsLocks = d2.mbsLocks.filter(l => l.id !== lockId);
      await store.setJSON("data", d2);
    } catch (_) {}
  };

  // 1bis) Code de reduction ou bon cadeau : verifie ET applique cote serveur
  //       (jamais depuis le navigateur). Le code est seulement reserve ici ;
  //       il n'est consomme qu'au paiement confirme.
  let remise = 0, couponCode = "", couponKind = "promo";
  if (body.coupon) {
    const cstore = couponStore();
    const chk = await checkCoupon(cstore, body.coupon, now);
    if (!chk.ok) {
      await releaseLock();
      return json({ ok: false, error: "coupon", message: reasonLabel(chk.reason) }, 400);
    }
    couponKind = chk.coupon.kind === "cadeau" ? "cadeau" : "promo";

    // Reservation faite AVEC un bon cadeau seul : la prestation et sa valeur
    // viennent du bon, jamais du navigateur (la personne ne choisit que sa date).
    if (couponKind === "cadeau" && body.giftOnly) {
      const val = Number(chk.coupon.amount);
      if (Number.isFinite(val) && val > 0) { total = val; totalPlein = val; }
      const s = chk.coupon.seance;
      type = (s === "duo" || s === "naissance") ? s : "grossesse";
    }

    remise = discountFor(total, chk.coupon.amount, couponKind);
    if (remise <= 0) {
      await releaseLock();
      return json({ ok: false, error: "coupon", message: "Ce code ne s'applique pas à cette formule." }, 400);
    }
    const pose = await reserveCoupon(cstore, chk.code, now + LOCK_TTL_MS);
    if (!pose) {
      await releaseLock();
      return json({ ok: false, error: "coupon", message: "Ce code vient d'être utilisé." }, 409);
    }
    couponCode = chk.code;
    total = total - remise;
  }

  // Acompte calcule sur le prix PLEIN (avant remise) : Matt encaisse le meme
  // acompte qu'une reservation sans code, c'est le solde du jour J qui baisse.
  // Garde-fou : l'acompte ne depasse jamais le total a payer.
  const acompte = Math.min(acompteFor(totalPlein), total);

  // Cas bon cadeau couvrant toute la seance : plus rien a payer en ligne.
  // Stripe ne sait pas encaisser 0 euro, on confirme donc la reservation ici.
  if (total <= 0) {
    try {
      await confirmerSansPaiement({
        store, lockId, now,
        md: {
          type, date, time, prenom, nom, email, tel, site,
          coupon: couponCode, remise: String(remise), totalPlein: String(totalPlein)
        }
      });
      return json({ ok: true, gratuit: true });
    } catch (e) {
      await releaseLock();
      if (couponCode) { try { await releaseCoupon(couponStore(), couponCode); } catch (_) {} }
      return json({ ok: false, error: "server", detail: String(e && e.message || e) }, 500);
    }
  }

  // 2) Session Stripe Checkout pour l'acompte.
  try {
    const stripe = new Stripe(secret);
    const label = "Acompte réservation " + typeLabelFr(type);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: acompte * 100,
          product_data: {
            name: label,
            description: "Séance du " + frDate(date) + " à " + time + " au studio, à La Mulatière."
          }
        }
      }],
      success_url: site + "/?reservation=ok&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?reservation=annulee",
      // expiration a 2 h : passe ce delai, Stripe previent et on relance le prospect
      expires_at: Math.floor(now / 1000) + 2 * 60 * 60,
      metadata: {
        app: "mybabyshoot", lockId, type, date, time, site,
        acompte: String(acompte), total: String(total),
        coupon: couponCode, remise: String(remise), totalPlein: String(totalPlein),
        prenom, nom, email, tel
      }
    });

    return json({ ok: true, url: session.url });
  } catch (e) {
    // Echec Stripe : on relache le verrou et le code promo pour ne rien bloquer.
    try {
      const d2 = await loadData(store);
      d2.mbsLocks = d2.mbsLocks.filter(l => l.id !== lockId);
      await store.setJSON("data", d2);
    } catch (_) {}
    if (couponCode) { try { await releaseCoupon(couponStore(), couponCode); } catch (_) {} }
    return json({ ok: false, error: "stripe_error", detail: String(e && e.message || e) }, 502);
  }
};

export const config = { path: "/.netlify/functions/mbs-checkout" };
