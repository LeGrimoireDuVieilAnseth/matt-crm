// netlify/functions/mbs-lien.js
// Cote cliente : la page payer.html du site lit un lien de paiement, puis
// demande la session Stripe au moment ou la cliente clique.
//
// PUBLIC, mais il faut CONNAITRE le code (8 caracteres tires au hasard).
// Ne renvoie jamais l'email ni le nom de famille : un lien se transfere,
// et se lit par-dessus une epaule.
//
//   GET  ?code=XXXX                      : ce qu'il y a a regler
//   POST ?code=XXXX {paiement, choix}    : ouvre le paiement
//
// LE TOTAL EST CALCULE ICI, PAS RECU DU NAVIGATEUR. La page n'envoie que
// des identifiants et des quantites ; les prix sont relus dans
// mbs-panier.mjs. C'est ce qui empeche de changer le prix en trafiquant
// l'adresse ou la requete.
import Stripe from "stripe";
import { lienStore, normaliserCode, vuePublique, panierDuLien, memoriserPanier,
         LIEN_SEUIL_3X, LIEN_MIN, LIEN_MAX } from "../mbs-liens.mjs";
import { resumePanier } from "../mbs-panier.mjs";

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

  /* Les pages d'avant le panier n'envoyaient qu'un identifiant de marche.
     On le traduit, pour qu'un lien ouvert dans un onglet resté ouvert
     continue de fonctionner. */
  const choix = (corps.choix && typeof corps.choix === "object")
    ? corps.choix
    : { formule: corps.option || "" };

  /* Tout le calcul est refait ici, a partir des seules quantites. */
  const panier = panierDuLien(lien, choix);

  if (panier.erreurs.length) {
    return json({ ok: false, erreur: "incomplet", messages: panier.erreurs }, 400);
  }
  if (!panier.lignes.length) {
    return json({ ok: false, erreur: "vide",
      messages: ["Choisissez au moins une chose avant de régler."] }, 400);
  }
  if (panier.total < LIEN_MIN) {
    return json({ ok: false, erreur: "trop_bas",
      messages: ["Le paiement en ligne commence à " + LIEN_MIN + " €."] }, 400);
  }
  if (panier.total > LIEN_MAX) {
    return json({ ok: false, erreur: "trop_haut",
      messages: ["Ce total dépasse ce qui peut être réglé en ligne. Appelez Matteo."] }, 400);
  }

  /* Le 3 fois se decide sur le TOTAL, et c'est le serveur qui tranche :
     une requete forgee ne peut pas l'obtenir sur 40 euros. */
  const troisFois = String(corps.paiement || "") === "3x" && panier.total >= LIEN_SEUIL_3X;

  try {
    const stripe = new Stripe(secret);
    const site = siteUrl();

    /* Une ligne Stripe par ligne du panier : la cliente retrouve le detail
       sur l'ecran de paiement et sur son recu, pas seulement un total. */
    const line_items = panier.lignes.map(l => ({
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: Math.round(l.montant * 100),
        product_data: {
          name: String(l.libelle).slice(0, 250),
          ...(l.detail ? { description: String(l.detail).slice(0, 250) } : {})
        }
      }
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      /* Un seul moyen par page, celui qu'elle vient de choisir : proposer
         la carte a cote de Klarna ferait s'ouvrir l'ecran Link par-dessus.
         Meme regle que sur les reservations et les bons cadeaux. */
      payment_method_types: troisFois ? ["klarna"] : ["card"],
      customer_email: lien.email || undefined,
      line_items,
      success_url: site + "/payer.html?c=" + code + "&ok=1",
      cancel_url: site + "/payer.html?c=" + code,
      metadata: {
        app: "mbs-lien", lienCode: code,
        clientId: lien.clientId || "", montant: String(panier.total),
        /* Le detail complet vit dans le lien, attache a cette session :
           les metadonnees Stripe sont limitees a 500 caracteres par champ. */
        libelle: resumePanier(panier).slice(0, 480),
        prenom: lien.prenom || "", nom: lien.nom || "",
        email: lien.email || "", site
      }
    });

    /* On garde le panier de CETTE session : c'est lui que la facture
       reprendra, meme si elle a ouvert le paiement deux fois avec deux
       choix differents. */
    await memoriserPanier(store, lien, session.id, panier);

    return json({ ok: true, url: session.url });
  } catch (e) {
    return json({ ok: false, erreur: "stripe", message: String((e && e.message) || e) }, 502);
  }
};
