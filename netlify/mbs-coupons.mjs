// netlify/mbs-coupons.mjs
// Codes de reduction a usage unique pour les reservations Mybabyshoot.
// Chaque code vaut -100 euros sur le TOTAL de la seance (l'acompte est
// ensuite recalcule sur le total remise deduite). Un code utilise ne peut
// plus jamais servir.
//
// Stockage (store Blobs "mbs-coupons") :
//   c-<CODE>    -> { code, batchId, amount, expiresAt, usedAt, sessionId, reservedUntil, disabled }
//   batch-<ID>  -> { id, nom, amount, expiresAt, createdAt, disabled, codes:[], used:[] }
//   batches     -> [ { id, nom, count, amount, expiresAt, createdAt, disabled } ]
import { getStore } from "@netlify/blobs";

export const COUPON_STORE  = "mbs-coupons";
export const COUPON_AMOUNT = 100;   // remise fixe en euros
export const MIN_TOTAL     = 190;   // total plancher apres remise (acompte + reste)

export function couponStore() {
  return getStore({ name: COUPON_STORE, consistency: "strong" });
}

// Alphabet sans caracteres ambigus (pas de O/0, I/1, L)
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeCode(len = 8) {
  const arr = new Uint32Array(len);
  globalThis.crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[arr[i] % ALPHABET.length];
  return s;
}

// "mbs 1a2b-3c4d " -> "MBS1A2B3C4D" : on ignore tirets, espaces et la casse
export function normalizeCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

// "ABCD1234" -> "ABCD-1234" (uniquement pour l'affichage)
export function prettyCode(code) {
  return String(code || "").replace(/(.{4})(?=.)/g, "$1-");
}

/* Verifie un code. Retourne { ok, reason, code, coupon }. */
export async function checkCoupon(store, rawCode, now = Date.now()) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: "vide" };
  let c = null;
  try { c = await store.get("c-" + code, { type: "json" }); } catch (e) {}
  if (!c)                                    return { ok: false, reason: "inconnu" };
  if (c.disabled)                            return { ok: false, reason: "desactive" };
  if (c.usedAt)                              return { ok: false, reason: "deja_utilise" };
  if (c.expiresAt && now > c.expiresAt)      return { ok: false, reason: "expire" };
  if (c.reservedUntil && now < c.reservedUntil) return { ok: false, reason: "en_cours" };
  return { ok: true, code, coupon: c };
}

/* Message clair pour le visiteur. */
export function reasonLabel(reason) {
  switch (reason) {
    case "vide":         return "Entrez un code.";
    case "inconnu":      return "Ce code n'existe pas.";
    case "desactive":    return "Ce code n'est plus valable.";
    case "deja_utilise": return "Ce code a deja ete utilise.";
    case "expire":       return "Ce code a expire.";
    case "en_cours":     return "Ce code est en cours d'utilisation. Reessayez dans quelques minutes.";
    default:             return "Ce code n'est pas valable.";
  }
}

/* Remise reellement applicable sur un total (jamais en dessous du plancher). */
export function discountFor(total, amount = COUPON_AMOUNT) {
  return Math.max(0, Math.min(amount, total - MIN_TOTAL));
}

/* Pose une reservation temporaire (le temps du paiement). */
export async function reserveCoupon(store, code, untilMs) {
  const c = await store.get("c-" + code, { type: "json" });
  if (!c || c.usedAt) return false;
  c.reservedUntil = untilMs;
  await store.setJSON("c-" + code, c);
  return true;
}

/* Libere une reservation (paiement abandonne ou erreur Stripe). */
export async function releaseCoupon(store, code) {
  try {
    const c = await store.get("c-" + code, { type: "json" });
    if (!c || c.usedAt) return;
    c.reservedUntil = 0;
    await store.setJSON("c-" + code, c);
  } catch (e) {}
}

/* Consomme definitivement le code (paiement confirme). */
export async function consumeCoupon(store, code, sessionId, now = Date.now()) {
  const c = await store.get("c-" + code, { type: "json" });
  if (!c || c.usedAt) return false;
  c.usedAt = now;
  c.sessionId = sessionId || "";
  c.reservedUntil = 0;
  await store.setJSON("c-" + code, c);
  // on note aussi l'usage dans le lot, pour le suivi cote CRM
  if (c.batchId) {
    try {
      const b = await store.get("batch-" + c.batchId, { type: "json" });
      if (b) {
        b.used = b.used || [];
        if (!b.used.includes(code)) b.used.push(code);
        await store.setJSON("batch-" + c.batchId, b);
      }
    } catch (e) {}
  }
  return true;
}
