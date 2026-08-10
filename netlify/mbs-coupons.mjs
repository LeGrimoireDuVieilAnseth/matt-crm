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

/* Remise reellement applicable sur un total.
   Code promo classique : jamais en dessous du plancher (il reste toujours a payer).
   Bon cadeau : la personne a deja paye, le bon peut couvrir la totalite. */
export function discountFor(total, amount = COUPON_AMOUNT, kind = "promo") {
  if (kind === "cadeau") return Math.max(0, Math.min(amount, total));
  return Math.max(0, Math.min(amount, total - MIN_TOTAL));
}

/* ---------- Bons cadeaux ----------
   Meme stockage que les codes promo, avec kind:"cadeau" et le montant reellement
   paye par l'acheteur. Index dedie "gifts" pour le suivi cote CRM. */
export const GIFT_VALIDITE_MOIS = 18;

/* Les offres achetables en bon cadeau : exactement les formules du site,
   puisque l'acheteur choisit sa formule dans le configurateur avant de
   cliquer sur "Offrir un bon cadeau". Le prix vient TOUJOURS d'ici, jamais
   du navigateur. Doit rester identique a OFFRES_CADEAU de js/bon.js. */
export const GIFT_OFFRES = [
  { id: "essentielle",   nom: "Essentielle",   prix: 290, duo: false },
  { id: "confort",       nom: "Confort",       prix: 390, duo: false },
  { id: "prestige",      nom: "Prestige",      prix: 490, duo: false },
  { id: "duo-essentiel", nom: "Duo Essentiel", prix: 590, duo: true  },
  { id: "duo-confort",   nom: "Duo Confort",   prix: 690, duo: true  },
  { id: "duo-prestige",  nom: "Duo Prestige",  prix: 890, duo: true  }
];

export function offreCadeau(id) {
  return GIFT_OFFRES.find(o => o.id === String(id || "")) || null;
}

/* Un bon cadeau s'affiche CADEAU-XXX-XXX (les tirets sont ignores a la saisie). */
export function prettyGift(code) {
  const c = String(code || "");
  if (!c.startsWith("CADEAU") || c.length !== 12) return prettyCode(c);
  return "CADEAU-" + c.slice(6, 9) + "-" + c.slice(9);
}

export async function createGiftCoupon(store, { amount, formule, seance, acheteur, beneficiaire, message, sessionId, now = Date.now() }) {
  // on retente si le code tire existe deja (probabilite infime, cout nul)
  let code = "";
  for (let i = 0; i < 5; i++) {
    const essai = "CADEAU" + makeCode(6);
    const deja = await store.get("c-" + essai, { type: "json" }).catch(() => null);
    if (!deja) { code = essai; break; }
  }
  if (!code) return null;

  const exp = new Date(now);
  exp.setMonth(exp.getMonth() + GIFT_VALIDITE_MOIS);
  const coupon = {
    code, kind: "cadeau", amount: Number(amount) || 0,
    formule: formule || "", seance: seance || "grossesse",
    batchId: "", expiresAt: exp.getTime(), createdAt: now,
    usedAt: 0, sessionId: "", reservedUntil: 0, disabled: false,
    acheteur: acheteur || {}, beneficiaire: beneficiaire || "", message: message || "",
    achatSession: sessionId || ""
  };
  await store.setJSON("c-" + code, coupon);

  // permet a la page de retour de retrouver le code juste apres le paiement
  if (sessionId) { try { await store.setJSON("sess-" + sessionId, { code }); } catch (e) {} }

  try {
    const idx = (await store.get("gifts", { type: "json" })) || [];
    idx.unshift({
      code, amount: coupon.amount, formule: coupon.formule, seance: coupon.seance,
      createdAt: now, expiresAt: coupon.expiresAt,
      acheteur: (acheteur && acheteur.nom) || "", email: (acheteur && acheteur.email) || "",
      beneficiaire: coupon.beneficiaire
    });
    await store.setJSON("gifts", idx.slice(0, 500));
  } catch (e) {}

  return coupon;
}

export function frDateShort(ms) {
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
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
