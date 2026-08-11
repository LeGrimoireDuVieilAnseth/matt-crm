// netlify/functions/mbs-gift.js
// Achat d'un bon cadeau Mybabyshoot : l'acheteur paie la totalite tout de suite,
// le code n'est cree qu'au paiement confirme (dans mbs-webhook).
import Stripe from "stripe";
import { offreCadeau } from "../mbs-coupons.mjs";

const SEANCE_LABEL = {
  grossesse: "Séance photo grossesse",
  naissance: "Séance photo naissance",
  duo:       "Séances photo grossesse et naissance"
};

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

  // L'offre fixe le prix cote serveur : le navigateur n'envoie qu'un identifiant.
  const offre = offreCadeau(body.offre);
  if (!offre) return json({ ok: false, error: "offre" }, 400);
  const montant = offre.prix;

  // Un duo couvre les deux seances ; sinon le client choisit grossesse ou naissance.
  const demande = String(body.seance || "");
  const seance = offre.duo ? "duo" : (demande === "naissance" ? "naissance" : "grossesse");

  const prenom = String(body.prenom || "").trim().slice(0, 60);
  const nom    = String(body.nom || "").trim().slice(0, 60);
  const email  = String(body.email || "").trim().slice(0, 120);
  const tel    = String(body.tel || "").trim().slice(0, 30);
  const pour   = String(body.pour || "").trim().slice(0, 60);      // prenom du beneficiaire
  const mot    = String(body.message || "").trim().slice(0, 200);  // petit mot sur le bon
  const label  = offre.nom;

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
            name: "Bon cadeau Mybabyshoot · formule " + label,
            description: (SEANCE_LABEL[seance] || "") + " · valable 18 mois au studio, à La Mulatière."
          }
        }
      }],
      success_url: site + "/?cadeau=ok&valeur=" + montant + "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?cadeau=annule",
      metadata: {
        app: "mbs-gift", montant: String(montant),
        offre: offre.id, seance, label,
        // Le site reellement utilise pour l'achat : c'est lui qui sert bon.html.
        // Sans ca l'email pointerait vers mybabyshoot.fr, encore chez Wix.
        site,
        prenom, nom, email, tel, pour, mot
      }
    });

    return json({ ok: true, url: session.url });
  } catch (e) {
    return json({ ok: false, error: "stripe_error", detail: String(e && e.message || e) }, 502);
  }
};

export const config = { path: "/.netlify/functions/mbs-gift" };
