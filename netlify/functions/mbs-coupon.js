// netlify/functions/mbs-coupon.js
// Verification d'un code de reduction depuis le site (avant paiement).
// Ne consomme rien : la remise n'est appliquee (et le code brule) que
// cote serveur dans mbs-checkout / mbs-webhook.
import { couponStore, checkCoupon, reasonLabel, discountFor, prettyCode } from "../mbs-coupons.mjs";

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
  const chk = await checkCoupon(store, body.code);

  if (!chk.ok) return json({ ok: true, valide: false, message: reasonLabel(chk.reason) });

  const remise = discountFor(total, chk.coupon.amount);
  if (remise <= 0) {
    return json({ ok: true, valide: false, message: "Ce code ne s'applique pas a cette formule." });
  }
  return json({
    ok: true, valide: true,
    code: prettyCode(chk.code),
    remise,
    nouveauTotal: total - remise,
    message: "Code valide : " + remise + " euros de remise."
  });
};

export const config = { path: "/.netlify/functions/mbs-coupon" };
