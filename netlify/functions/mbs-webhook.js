// netlify/functions/mbs-webhook.js
// Webhook Stripe : appele par Stripe quand un paiement d'acompte est confirme.
// Verifie la signature (STRIPE_WEBHOOK_SECRET), puis enregistre la reservation
// confirmee dans le CRM (client + seance + paiement, brand "mybabyshoot"),
// libere le verrou, notifie Matt et envoie l'email de confirmation au client.
import Stripe from "stripe";
import { crmStore, loadData, pruneLocks, uid, typeLabelFr, PLACE, BRAND } from "../mbs-lib.mjs";
import { notifyAll } from "../push-lib.mjs";
import nodemailer from "nodemailer";
import { makeInvoicePdf, nextInvoiceNumber } from "../mbs-invoice.mjs";

function frDate(iso){
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

async function sendClientEmail(m){
  // Envoi "maison" via SMTP de la boite mail de Matt (identifiants dans Netlify).
  const host = process.env.MBS_SMTP_HOST;
  const user = process.env.MBS_SMTP_USER;
  const pass = process.env.MBS_SMTP_PASS;
  const from = process.env.MBS_FROM_EMAIL || user;
  if (!host || !user || !pass || !m.email) return; // SMTP non configure : on n'envoie rien
  const port = Number(process.env.MBS_SMTP_PORT || 465);
  const secure = process.env.MBS_SMTP_SECURE ? (process.env.MBS_SMTP_SECURE === "true") : (port === 465);
  const reste = Math.max(0, Number(m.total) - Number(m.acompte));
  const html =
    "<p>Bonjour " + (m.prenom || "") + ",</p>" +
    "<p>Votre reservation est confirmee. Merci et a tres vite au studio.</p>" +
    "<ul>" +
    "<li><b>Seance :</b> " + typeLabelFr(m.type) + "</li>" +
    "<li><b>Date :</b> " + frDate(m.date) + " a " + m.time + "</li>" +
    "<li><b>Lieu :</b> " + PLACE + "</li>" +
    "<li><b>Acompte regle :</b> " + m.acompte + " euros</li>" +
    "<li><b>Solde le jour de la seance :</b> " + reste + " euros</li>" +
    "</ul>" +
    (m.invPdf ? "<p>Votre facture d'acompte est en piece jointe.</p>" : "") +
    "<p>Une question ? Repondez a cet email ou appelez le 06 47 76 54 17.</p>" +
    "<p>Mybabyshoot</p>";
  const bcc = process.env.MBS_INVOICE_EMAIL || "mybabyshoot.contact@gmail.com";
  const attachments = m.invPdf
    ? [{ filename: "Facture-" + (m.invNum || "acompte") + ".pdf", content: m.invPdf, contentType: "application/pdf" }]
    : [];
  try {
    const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transport.sendMail({
      from, to: m.email, bcc, subject: "Votre reservation est confirmee . Mybabyshoot", html, attachments
    });
  } catch (e) { /* non bloquant : l'email ne doit jamais faire echouer la reservation */ }
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

  if (event.type !== "checkout.session.completed")
    return new Response(JSON.stringify({ received: true, ignored: event.type }), { status: 200 });

  const session = event.data.object;
  const md = session.metadata || {};
  if (md.app !== "mybabyshoot")
    return new Response(JSON.stringify({ received: true, ignored: "other_app" }), { status: 200 });
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
      tel, email, insta: "", source: "Reservation site Mybabyshoot",
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
    notes: "Reservation en ligne. Total seance " + total + " euros, acompte " + acompte + " euros encaisse.",
    createdAt: now, stripeSession: session.id
  });

  // Paiement (acompte encaisse ; le CRM affiche le reste du).
  data.paiements.push({
    id: uid(), brand: BRAND, clientId: client.id,
    label: "Acompte reservation " + typeLbl,
    total: String(total), acompte: String(acompte), statut: "Acompte",
    date: new Date(now).toISOString().slice(0, 10), dueDate: date,
    notes: "Regle en ligne via Stripe.", stripeSession: session.id
  });

  // Liberation du verrou pose au checkout.
  if (md.lockId) data.mbsLocks = data.mbsLocks.filter(l => l.id !== md.lockId);

  data.t = now;
  await store.setJSON("data", data);

  // Notification push a Matt.
  try {
    await notifyAll(
      "Nouvelle reservation Mybabyshoot",
      name + " . " + typeLbl + " le " + frDate(date) + " a " + time + " . acompte " + acompte + " euros",
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
