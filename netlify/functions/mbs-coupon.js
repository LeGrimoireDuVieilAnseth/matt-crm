// netlify/functions/mbs-coupon.js
// Verification d'un code de reduction depuis le site (avant paiement).
// Ne consomme rien : la remise n'est appliquee (et le code brule) que
// cote serveur dans mbs-checkout / mbs-webhook.
import { couponStore, checkCoupon, reasonLabel, discountFor, prettyCode, prettyGift } from "../mbs-coupons.mjs";
import { porteFermee, noterEchec, LIMITE_CODES, MESSAGE_TROP_CODES } from "../mbs-garde.mjs";

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

  const total = Math.max(0, Math.round(Number(body.total)) || 0);
  const store = couponStore();
  /* Essais rates limites par adresse : voir mbs-garde.mjs. La reponse
     garde sa forme habituelle, le site l'affiche telle quelle. */
  if (await porteFermee("codes", request, LIMITE_CODES))
    return json({ ok: true, valide: false, message: MESSAGE_TROP_CODES });
  const chk = await checkCoupon(store, body.code);
  if (!chk.ok && chk.reason === "inconnu") await noterEchec("codes", request, LIMITE_CODES);

  if (!chk.ok) return json({ ok: true, valide: false, message: reasonLabel(chk.reason) });

  const kind = chk.coupon.kind === "cadeau" ? "cadeau" : "promo";
  const remise = discountFor(total, chk.coupon.amount, kind);
  if (remise <= 0) {
    return json({ ok: true, valide: false, message: "Ce code ne s'applique pas a cette formule." });
  }
  const reste = total - remise;
  return json({
    ok: true, valide: true,
    // un bon cadeau s'affiche brut, prettyCode le decouperait par groupes de 4
    code: kind === "cadeau" ? prettyGift(chk.code) : prettyCode(chk.code),
    kind, remise,
    nouveauTotal: reste,
    message: kind === "cadeau"
      ? (reste === 0
          ? "Bon cadeau validé : la séance est entièrement couverte, il n'y a rien à payer."
          : "Bon cadeau validé : " + remise + " € déduits.")
      : "Code valide : " + remise + " € de remise."
  });
};

export const config = { path: "/.netlify/functions/mbs-coupon" };
