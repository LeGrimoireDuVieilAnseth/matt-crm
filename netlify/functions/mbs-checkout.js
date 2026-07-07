// netlify/functions/mbs-checkout.js
// Cree une session Stripe Checkout pour l'acompte d'une reservation Mybabyshoot.
// Pose d'abord un verrou anti-doublon sur le creneau (un seul client par creneau).
// La cle secrete Stripe est lue dans l'environnement Netlify (STRIPE_SECRET_KEY),
// jamais dans le code.
import Stripe from "stripe";
import {
  crmStore, loadData, pruneLocks, isFree, isValidSlot,
  acompteFor, typeLabelFr, LOCK_TTL_MS, uid, BRAND
} from "../mbs-lib.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ ok: false, error: "stripe_not_configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  const type   = String(body.type || "grossesse");
  const date   = String(body.date || "");
  const time   = String(body.time || "");
  const client = body.client || {};
  const prenom = String(client.prenom || "").trim();
  const nom    = String(client.nom || "").trim();
  const email  = String(client.email || "").trim();
  const tel    = String(client.tel || "").trim();

  if (!isValidSlot(date, time)) return json({ ok: false, error: "invalid_slot" }, 400);
  if (!prenom || !email) return json({ ok: false, error: "missing_client" }, 400);

  // Acompte recalcule cote serveur : on ne fait jamais confiance au montant du client.
  const acompte = acompteFor(type);
  // Total de la seance (informatif, pour le reste du affiche dans le CRM).
  let total = Math.round(Number(body.total));
  if (!Number.isFinite(total) || total < acompte || total > 5000) total = acompte;

  const store = crmStore();
  const now = Date.now();

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

  // 2) Session Stripe Checkout pour l'acompte.
  try {
    const stripe = new Stripe(secret);
    const origin = request.headers.get("origin") || "";
    const site = (process.env.MBS_SITE_URL || origin || "https://mybabyshoot.fr").replace(/\/+$/, "");
    const label = "Acompte reservation " + typeLabelFr(type);

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
            description: "Seance du " + date + " a " + time + " au studio (La Mulatiere)."
          }
        }
      }],
      success_url: site + "/?reservation=ok&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?reservation=annulee",
      metadata: {
        app: "mybabyshoot", lockId, type, date, time,
        acompte: String(acompte), total: String(total),
        prenom, nom, email, tel
      }
    });

    return json({ ok: true, url: session.url });
  } catch (e) {
    // Echec Stripe : on relache le verrou pour ne pas bloquer le creneau inutilement.
    try {
      const d2 = await loadData(store);
      d2.mbsLocks = d2.mbsLocks.filter(l => l.id !== lockId);
      await store.setJSON("data", d2);
    } catch (_) {}
    return json({ ok: false, error: "stripe_error", detail: String(e && e.message || e) }, 502);
  }
};

export const config = { path: "/.netlify/functions/mbs-checkout" };
