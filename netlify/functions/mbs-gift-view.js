// netlify/functions/mbs-gift-view.js
// Lecture publique d'un bon cadeau pour l'afficher et le telecharger (page bon.html).
// Public mais il faut CONNAITRE le code (ou l'id de session Stripe juste apres l'achat).
// Ne renvoie jamais les coordonnees de l'acheteur.
import { couponStore, normalizeCode, prettyGift } from "../mbs-coupons.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

function frDate(ms) {
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);

  const url = new URL(request.url);
  const store = couponStore();

  // Retour de Stripe : on ne connait que la session, le webhook a note le code.
  let code = normalizeCode(url.searchParams.get("code") || "");
  const sess = (url.searchParams.get("session") || "").slice(0, 120);
  if (!code && sess) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(sess)) return json({ ok: false, error: "session" }, 400);
    let lien = null;
    try { lien = await store.get("sess-" + sess, { type: "json" }); } catch (e) {}
    // le webhook n'a peut-etre pas encore tourne : le site reessaiera
    if (!lien || !lien.code) return json({ ok: false, error: "pas_encore" }, 404);
    code = lien.code;
  }
  if (!code) return json({ ok: false, error: "code" }, 400);

  let c = null;
  try { c = await store.get("c-" + code, { type: "json" }); } catch (e) {}
  if (!c || c.kind !== "cadeau") return json({ ok: false, error: "inconnu" }, 404);

  return json({
    ok: true,
    bon: {
      code: prettyGift(c.code),
      formule: c.formule || "",
      seance: c.seance || "grossesse",
      style: c.style || "",
      montant: c.amount || 0,
      pour: c.beneficiaire || "",
      message: c.message || "",
      expire: frDate(c.expiresAt),
      utilise: !!c.usedAt,
      desactive: !!c.disabled
    }
  });
};

export const config = { path: "/.netlify/functions/mbs-gift-view" };
