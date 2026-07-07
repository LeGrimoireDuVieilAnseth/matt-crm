// netlify/functions/mbs-webhook.js
// Webhook Stripe : appele par Stripe quand un paiement d'acompte est confirme.
// Verifie la signature (STRIPE_WEBHOOK_SECRET), puis enregistre la reservation
// confirmee dans le CRM (client + seance + paiement, brand "mybabyshoot"),
// libere le verrou, notifie Matt et envoie l'email de confirmation au client.
import Stripe from "stripe";
import { crmStore, loadData, pruneLocks, uid, typeLabelFr, PLACE, BRAND } from "../mbs-lib.mjs";
import { notifyAll } from "../push-lib.mjs";

function frDate(iso){
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

async function sendClientEmail(m){
  const key = process.env.RESEND_API_KEY, from = process.env.MBS_FROM_EMAIL;
  if (!key || !from || !m.email) return; // email non configure : on n'envoie rien
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
    "<p>Une question ? Repondez a cet email ou appelez le 06 47 76 54 17.</p>" +
    "<p>Mybabyshoot</p>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [m.email], subject: "Votre reservation est confirmee . Mybabyshoot", html
      })
    });
  } catch (e) { /* non bloquant */ }
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

  // Email de confirmation au client (best effort).
  await sendClientEmail({ prenom, email, type, date, time, acompte, total });

  return new Response(JSON.stringify({ received: true, booked: true }), { status: 200 });
};

export const config = { path: "/.netlify/functions/mbs-webhook" };
