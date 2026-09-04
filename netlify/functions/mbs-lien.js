// netlify/functions/mbs-lien.js
// Cote cliente : la page payer.html du site lit un lien de paiement, puis
// demande la session Stripe au moment ou la cliente clique.
//
// PUBLIC, mais il faut CONNAITRE le code (8 caracteres tires au hasard).
// Ne renvoie jamais l'email ni le nom de famille : un lien se transfere,
// et se lit par-dessus une epaule.
//
//   GET  ?code=XXXX                     : ce qu'il y a a regler
//   POST ?code=XXXX {paiement:"carte"}  : ouvre le paiement, rend l'adresse Stripe
//
// LE MONTANT EST LU ICI, PAS RECU DU NAVIGATEUR. C'est ce qui empeche de
// changer le prix en trafiquant l'adresse.
import Stripe from "stripe";
import { lienStore, normaliserCode, vuePublique, LIEN_SEUIL_3X } from "../mbs-liens.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const siteUrl = () =>
  (process.env.MBS_SITE_URL || "https://www.mybabyshoot.fr").replace(/\/+$/, "");

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const code = normaliserCode(url.searchParams.get("code") || "");
  if (!code) return json({ ok: false, erreur: "code" }, 400);

  const store = lienStore();
  let lien = null;
  try { lien = await store.get("l-" + code, { type: "json" }); } catch (e) {}
  if (!lien) return json({ ok: false, erreur: "introuvable" }, 404);

  if (request.method === "GET") return json({ ok: true, lien: vuePublique(lien) });
  if (request.method !== "POST") return json({ ok: false, erreur: "methode" }, 405);

  if (lien.statut === "paye") return json({ ok: false, erreur: "deja_paye" }, 409);
  if (lien.statut === "annule") return json({ ok: false, erreur: "annule" }, 409);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ ok: false, erreur: "stripe" }, 503);

  let corps = {};
  try { corps = await request.json(); } catch (e) {}
  /* Le 3 fois n'est propose qu'au-dessus du seuil, et c'est le serveur qui
     tranche : une requete forgee ne peut pas l'obtenir sur 40 euros. */
  const troisFois = String(corps.paiement || "") === "3x" && lien.montant >= LIEN_SEUIL_3X;

  try {
    const stripe = new Stripe(secret);
    const site = siteUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      /* Un seul moyen par page, celui qu'elle vient de choisir : proposer
         la carte a cote de Klarna ferait s'ouvrir l'ecran Link par-dessus.
         Meme regle que sur les reservations et les bons cadeaux. */
      payment_method_types: troisFois ? ["klarna"] : ["card"],
      customer_email: lien.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: lien.montant * 100,
          product_data: {
            name: lien.libelle,
            description: "Complément Mybabyshoot" + (lien.prenom ? " pour " + lien.prenom : "")
          }
        }
      }],
      success_url: site + "/payer.html?c=" + code + "&ok=1",
      cancel_url: site + "/payer.html?c=" + code,
      metadata: {
        app: "mbs-lien", lienCode: code,
        clientId: lien.clientId || "", montant: String(lien.montant),
        libelle: lien.libelle, prenom: lien.prenom || "", nom: lien.nom || "",
        email: lien.email || "", site
      }
    });
    return json({ ok: true, url: session.url });
  } catch (e) {
    return json({ ok: false, erreur: "stripe", message: String((e && e.message) || e) }, 502);
  }
};
