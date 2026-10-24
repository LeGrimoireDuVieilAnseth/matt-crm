// netlify/functions/mlp-resa.js
// La reservation d'un shooting portrait Matt la Photo (shooting.html du site
// Matt la Photo). Meme chemin que mbs-availability + mbs-checkout pour
// Mybabyshoot ; les regles propres aux shootings sont dans ../mlp-resa.mjs.
//
// PUBLIC, adresse neutre /resa-api :
//   GET                 : les creneaux libres, et la grille (formules, photos)
//   POST {gamme, photos, lieu, paiement, date, time, client, totalAffiche}
//                       : pose le verrou du creneau et ouvre le paiement Stripe
//                         (compte Matt la Photo). Le webhook enregistre le reste.
import Stripe from "stripe";
import { crmStore, loadData, pruneLocks, uid } from "../mbs-lib.mjs";
import { FORMULES_MLP, SLOTS_MLP, GRILLE_PHOTOS, PHOTOS_EN_PLUS_MAX, BRAND_MLP, LOCK_TTL_MS,
         isValidSlotMlp, isFreeMlp, disponibilitesMlp, prixShooting, acompteMlp } from "../mlp-resa.mjs";
import { calculerDeplacement, RAYON_OFFERT_KM } from "../mbs-deplacement.mjs";
import { marqueDe } from "../marques.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const MARQUE = marqueDe("matt-la-photo");
const frDate = (iso) => { const p = String(iso).split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso; };
const ORIGINES = ["Google Ads", "Google", "Instagram", "TikTok", "Facebook", "Autre moteur", "Autre site", "Direct"];

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = crmStore();

  /* ---------- les creneaux libres ---------- */
  if (request.method === "GET") {
    try {
      const data = await loadData(store);
      return json({ ok: true, slots: SLOTS_MLP, days: disponibilitesMlp(data),
        formules: FORMULES_MLP, photos: { ...GRILLE_PHOTOS, max: PHOTOS_EN_PLUS_MAX }, rayonOffert: RAYON_OFFERT_KM,
        paiement: !!MARQUE.stripeSecret() });
    } catch (e) { return json({ ok: false, error: "server" }, 500); }
  }
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const secret = MARQUE.stripeSecret();
  if (!secret) return json({ ok: false, error: "paiement",
    message: "La réservation en ligne n'est pas encore ouverte. Appelez-moi au 06 47 76 54 17, on fixe la date ensemble." }, 503);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "json" }, 400); }

  const date = String(body.date || ""), time = String(body.time || "");
  const c = body.client || {};
  const prenom = String(c.prenom || "").trim().slice(0, 60), nom = String(c.nom || "").trim().slice(0, 60);
  const email = String(c.email || "").trim().slice(0, 160), tel = String(c.tel || "").trim().slice(0, 30);
  const integral = String(body.paiement || "") === "integral";
  const origine = ORIGINES.includes(String(body.origine || "")) ? String(body.origine) : "Direct";
  if (!isValidSlotMlp(date, time)) return json({ ok: false, error: "invalid_slot" }, 400);
  if (!prenom || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: "missing_client" }, 400);

  const p = prixShooting({ gamme: body.gamme, photos: body.photos });
  if (!p) return json({ ok: false, error: "formule", message: "Formule non reconnue. Rechargez la page et recommencez." }, 400);
  const f = FORMULES_MLP[body.gamme];
  /* L'offre video : pas de reservation sans l'accord d'etre filme(e) et
     publie(e) sur TikTok et Instagram. Le compte a identifier est
     facultatif. */
  if (f.video && body.consentVideo !== true) return json({ ok: false, error: "consentement",
    message: "Pour l'offre Matt la Photo, cochez la case qui autorise la vidéo et sa publication." }, 400);
  const reseau = f.video ? String(body.reseau || "").trim().replace(/\s+/g, "").slice(0, 60) : "";
  const adresse = String(body.lieu || "").trim().slice(0, 160);
  if (adresse.length < 3) return json({ ok: false, error: "lieu", message: "Indiquez le lieu du shooting." }, 400);

  /* Le deplacement, recalcule ici depuis la seule adresse : le navigateur
     n'envoie jamais de montant. */
  const d = await calculerDeplacement(adresse);
  if (!d.ok) return json({ ok: false, error: "lieu", message: d.raison === "trop_loin"
    ? "Ce lieu est au-delà de mon rayon de déplacement. Appelez-moi au 06 47 76 54 17, on trouve une solution."
    : "Adresse du lieu non reconnue. Reprenez-la dans le formulaire." }, 400);
  const totalPlein = p.total;
  const total = totalPlein + d.frais;

  /* Ce que la personne a vu doit couvrir ce qu'on va lui compter. */
  const vu = Math.round(Number(body.totalAffiche));
  if (Number.isFinite(vu) && vu < total) return json({ ok: false, error: "prix",
    message: "Les tarifs ont changé depuis l'ouverture de la page. Rechargez-la pour voir le prix à jour." }, 409);

  /* Le verrou : on relit, on nettoie, on verifie le creneau. */
  const now = Date.now();
  const data = await loadData(store);
  pruneLocks(data, now);
  if (!isFreeMlp(data, date, time, now)) {
    await store.setJSON("data", data);
    return json({ ok: false, error: "slot_taken" }, 409);
  }
  const lockId = uid();
  data.mbsLocks.push({ id: lockId, brand: BRAND_MLP, date, time, expiresAt: now + LOCK_TTL_MS });
  await store.setJSON("data", data);
  const liberer = async () => {
    try { const d2 = await loadData(store); d2.mbsLocks = d2.mbsLocks.filter(l => l.id !== lockId); await store.setJSON("data", d2); } catch (e) {}
  };

  /* Acompte calcule sur le prix de la seance, hors deplacement, comme pour
     Mybabyshoot. En 3 fois avec Klarna, tout est regle maintenant. */
  const acompte = integral ? total : Math.min(acompteMlp(totalPlein), total);
  const site = MARQUE.site();
  try {
    const session = await new Stripe(secret).checkout.sessions.create({
      mode: "payment",
      /* Un seul moyen par page : Klarna seul sur le 3 fois, sinon Link
         s'ouvre par-dessus et cache Klarna (meme regle que Mybabyshoot). */
      payment_method_types: integral ? ["klarna"] : ["card"],
      customer_email: email,
      line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: Math.round(acompte * 100),
        product_data: { name: (integral ? "Shooting portrait, " : "Acompte shooting portrait, ") + (f.video ? f.nom + " (shooting + vidéo)" : "formule " + f.nom),
          description: "Le " + frDate(date) + " à " + time.replace(":", "h") + ", " + d.label + "." } } }],
      success_url: site + "/shooting.html?reservation=ok&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/shooting.html?reservation=annulee#reserver",
      /* La relance part quand Stripe declare la session expiree (24 h au plus). */
      expires_at: Math.floor(now / 1000) + 23 * 60 * 60 + 55 * 60,
      metadata: {
        app: "mlp-resa", lockId, gamme: String(body.gamme), photos: String(p.photos), date, time,
        lieuExt: d.label, km: String(d.km), fraisDepl: String(d.frais),
        acompte: String(acompte), total: String(total), totalPlein: String(totalPlein),
        integral: integral ? "1" : "", origine, prenom, nom, email, tel, site,
        video: f.video ? "1" : "", consentVideo: f.video ? new Date(now).toISOString() : "", reseau
      }
    });
    return json({ ok: true, url: session.url });
  } catch (e) {
    await liberer();
    return json({ ok: false, error: "stripe", message: "Le paiement n'a pas pu s'ouvrir. Réessayez dans un instant." }, 502);
  }
};

export const config = { path: ["/.netlify/functions/mlp-resa", "/resa-api"] };
