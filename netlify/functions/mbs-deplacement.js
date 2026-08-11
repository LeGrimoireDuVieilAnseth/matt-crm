// netlify/functions/mbs-deplacement.js
// Frais de deplacement d'une seance en exterieur, calcules depuis une adresse.
// Public : le site l'appelle pendant que le visiteur compose sa seance.
// Le montant est TOUJOURS recalcule au paiement (mbs-checkout) : cette
// reponse ne sert qu'a afficher un prix, jamais a le fixer.
import { calculerDeplacement, RAYON_OFFERT_KM } from "../mbs-deplacement.mjs";

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

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  const adresse = String(body.adresse || "").trim().slice(0, 160);
  if (adresse.length < 3) return json({ ok: false, error: "adresse" }, 400);

  const d = await calculerDeplacement(adresse);

  if (!d.ok) {
    const messages = {
      introuvable: "Adresse introuvable. Essayez avec le code postal, ou juste le nom de la commune.",
      imprecis:    "Adresse trop imprécise. Ajoutez le code postal ou la commune.",
      trop_loin:   "C'est au-delà de mon rayon de déplacement. Appelez-moi au 06 47 76 54 17, on trouve une solution."
    };
    return json({ ok: true, valide: false, raison: d.raison, message: messages[d.raison] || "Adresse non reconnue." });
  }

  return json({
    ok: true, valide: true,
    label: d.label, km: d.km, frais: d.frais, offert: d.offert,
    message: d.offert
      ? "Déplacement offert : vous êtes à " + d.km + " km du studio."
      : "À " + d.km + " km du studio. Les " + RAYON_OFFERT_KM + " premiers kilomètres sont offerts, le reste couvre l'aller-retour et les péages."
  });
};

export const config = { path: "/.netlify/functions/mbs-deplacement" };
