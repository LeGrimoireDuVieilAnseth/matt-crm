// netlify/functions/mbs-gift.js
// Achat d'un bon cadeau Mybabyshoot : l'acheteur paie la totalite tout de suite,
// le code n'est cree qu'au paiement confirme (dans mbs-webhook).
import Stripe from "stripe";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

// Montants proposes : les formules du studio, plus un montant libre encadre.
export const GIFT_MIN = 90;
export const GIFT_MAX = 1500;

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ ok: false, error: "stripe_not_configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  const montant = Math.round(Number(body.montant));
  if (!Number.isFinite(montant) || montant < GIFT_MIN || montant > GIFT_MAX)
    return json({ ok: false, error: "montant" }, 400);

  const prenom = String(body.prenom || "").trim().slice(0, 60);
  const nom    = String(body.nom || "").trim().slice(0, 60);
  const email  = String(body.email || "").trim().slice(0, 120);
  const tel    = String(body.tel || "").trim().slice(0, 30);
  const pour   = String(body.pour || "").trim().slice(0, 60);      // prenom du beneficiaire
  const mot    = String(body.message || "").trim().slice(0, 200);  // petit mot sur le bon
  const label  = String(body.label || "").trim().slice(0, 80);     // formule choisie, pour info

  if (!prenom || !email) return json({ ok: false, error: "missing_client" }, 400);

  try {
    const stripe = new Stripe(secret);
    const origin = request.headers.get("origin") || "";
    const site = (process.env.MBS_SITE_URL || origin || "https://mybabyshoot.fr").replace(/\/+$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: montant * 100,
          product_data: {
            name: "Bon cadeau Mybabyshoot" + (label ? " . " + label : ""),
            description: "Valable 18 mois sur toutes les seances du studio (La Mulatiere)."
          }
        }
      }],
      success_url: site + "/?cadeau=ok&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?cadeau=annule",
      metadata: {
        app: "mbs-gift", montant: String(montant),
        prenom, nom, email, tel, pour, mot, label
      }
    });

    return json({ ok: true, url: session.url });
  } catch (e) {
    return json({ ok: false, error: "stripe_error", detail: String(e && e.message || e) }, 502);
  }
};

export const config = { path: "/.netlify/functions/mbs-gift" };
