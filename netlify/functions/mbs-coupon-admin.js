// netlify/functions/mbs-coupon-admin.js
// Gestion des codes de reduction depuis le CRM (protege par CRM_KEY).
// - GET  ?lots=1        : liste des lots
// - GET  ?lot=ID        : detail d'un lot (chaque code + son etat)
// - GET  ?offres=1      : formules disponibles en bon cadeau
// - POST {action:"creer", nom, nombre, expiresAt}  : genere un lot de codes
// - POST {action:"cadeau-manuel", formule, beneficiaire, acheteur, message}
//                       : cree UN bon cadeau, pour honorer un ancien bon
// - POST {action:"desactiver", lot, off}           : (re)active un lot entier
// - POST {action:"supprimer", lot}                 : supprime le lot et ses codes
// - POST {action:"cadeau-corriger", code, seance, beneficiaire, message, style}
//                       : corrige ce qui est ECRIT sur un bon, sans toucher au code
// - POST {action:"cadeau-renvoyer", code, email, explication}
//                       : renvoie le bon par email, avec le meme code
import { couponStore, makeCode, prettyCode, prettyGift, normalizeCode, COUPON_AMOUNT,
         createGiftCoupon, offreCadeau, GIFT_OFFRES, styleValide } from "../mbs-coupons.mjs";
import { htmlBonCadeau, htmlBonCorrige, SEANCE_TXT } from "../mbs-bon-mail.mjs";
import { sendMail } from "../mbs-mail.mjs";

/* Les trois natures de seance qu'un bon peut porter. C'est la seule liste
   qui fait foi : une valeur inconnue afficherait un bon muet. */
const SEANCES_BON = ["grossesse", "naissance", "duo"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const REQUIRED = process.env.CRM_KEY || "";
const authorized = (request) => !REQUIRED || (request.headers.get("x-crm-key") || "") === REQUIRED;

const MAX_PAR_LOT = 500;

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);

  const store = couponStore();

  if (request.method === "GET") {
    const url = new URL(request.url);
    // bons cadeaux vendus sur le site (etat lu code par code)
    if (url.searchParams.get("cadeaux")) {
      let idx = [];
      try { idx = (await store.get("gifts", { type: "json" })) || []; } catch (e) {}
      const cadeaux = [];
      for (const g of idx.slice(0, 200)) {
        let c = null;
        try { c = await store.get("c-" + g.code, { type: "json" }); } catch (e) {}
        cadeaux.push({
          code: prettyGift(g.code), brut: g.code,
          montant: g.amount, formule: g.formule || "", seance: g.seance || "",
          createdAt: g.createdAt, expiresAt: g.expiresAt,
          acheteur: g.acheteur || "", email: g.email || "", beneficiaire: g.beneficiaire || "",
          utilise: !!(c && c.usedAt), useAt: (c && c.usedAt) || 0,
          disabled: !!(c && c.disabled)
        });
      }
      return json({ ok: true, cadeaux });
    }
    // De quoi remplir le menu du CRM sans y recopier les prix.
    if (url.searchParams.get("offres")) {
      return json({ ok: true, offres: GIFT_OFFRES });
    }
    if (url.searchParams.get("lots")) {
      let lots = [];
      try { lots = (await store.get("batches", { type: "json" })) || []; } catch (e) {}
      // on rafraichit le nombre d'utilises depuis chaque lot
      for (const l of lots) {
        try {
          const b = await store.get("batch-" + l.id, { type: "json" });
          l.utilises = b && b.used ? b.used.length : 0;
          l.disabled = b ? !!b.disabled : !!l.disabled;
        } catch (e) { l.utilises = 0; }
      }
      return json({ ok: true, lots });
    }
    const id = (url.searchParams.get("lot") || "").replace(/[^a-z0-9]/gi, "");
    if (!id) return json({ ok: false, error: "lot" }, 400);
    const b = await store.get("batch-" + id, { type: "json" });
    if (!b) return json({ ok: false, error: "notfound" }, 404);
    const used = new Set(b.used || []);
    const codes = (b.codes || []).map(c => ({
      code: prettyCode(c),
      brut: c,
      utilise: used.has(c)
    }));
    return json({ ok: true, lot: { id: b.id, nom: b.nom, amount: b.amount, expiresAt: b.expiresAt, createdAt: b.createdAt, disabled: !!b.disabled }, codes });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  // ---------- un bon cadeau precis ----------
  // Deux gestes differents : "annuler" rend le code inutilisable mais garde la
  // trace de la vente (c'est une vraie recette, elle a une facture) ;
  // "supprimer" efface tout, pour nettoyer les bons de test.
  if (body.action === "cadeau-annuler" || body.action === "cadeau-supprimer") {
    const code = normalizeCode(body.code);
    if (!code) return json({ ok: false, error: "code" }, 400);
    let c = null;
    try { c = await store.get("c-" + code, { type: "json" }); } catch (e) {}
    if (!c || c.kind !== "cadeau") return json({ ok: false, error: "introuvable" }, 404);

    if (body.action === "cadeau-annuler") {
      c.disabled = !!body.off;
      await store.setJSON("c-" + code, c);
      return json({ ok: true, disabled: c.disabled });
    }

    // suppression definitive : le code, le lien avec la session, et l'index
    try { await store.delete("c-" + code); } catch (e) {}
    if (c.achatSession) { try { await store.delete("sess-" + c.achatSession); } catch (e) {} }
    try {
      const idx = (await store.get("gifts", { type: "json" })) || [];
      await store.setJSON("gifts", idx.filter(g => g.code !== code));
    } catch (e) {}
    return json({ ok: true, supprime: true });
  }

  // ---------- corriger ce qui est ECRIT sur un bon ----------
  /* Un acheteur s'est trompe de case au moment d'acheter : son bon dit
     "grossesse" alors qu'il voulait "naissance". Rien n'oblige a lui en
     refaire un : le bon n'est pas un fichier fige, c'est une page que
     mbs-gift-view recompose a chaque ouverture depuis ce qui est stocke
     ici. Corriger la donnee corrige donc le bon que l'acheteur a deja,
     avec le meme lien et le meme code.

     Le montant et la formule ne sont PAS modifiables : ils disent ce qui
     a ete paye, et une facture existe en face. Changer l'un sans l'autre
     fabriquerait un bon qui ment sur sa propre valeur. Pour un vrai
     changement de formule, il faut un complement de paiement, ce qui est
     une autre histoire. */
  if (body.action === "cadeau-corriger") {
    const code = normalizeCode(body.code);
    if (!code) return json({ ok: false, error: "code" }, 400);
    let c = null;
    try { c = await store.get("c-" + code, { type: "json" }); } catch (e) {}
    if (!c || c.kind !== "cadeau") return json({ ok: false, error: "introuvable" }, 404);

    const change = [];
    if (body.seance != null && body.seance !== c.seance) {
      const s = String(body.seance);
      if (!SEANCES_BON.includes(s)) return json({ ok: false, error: "seance" }, 400);
      change.push("séance : " + (SEANCE_TXT[c.seance] || c.seance) + " → " + SEANCE_TXT[s]);
      c.seance = s;
    }
    if (body.beneficiaire != null) {
      const b = String(body.beneficiaire).trim().slice(0, 80);
      if (b !== (c.beneficiaire || "")) { change.push("offert à : " + (b || "personne")); c.beneficiaire = b; }
    }
    if (body.message != null) {
      const m = String(body.message).trim().slice(0, 300);
      if (m !== (c.message || "")) { change.push("mot personnel"); c.message = m; }
    }
    if (body.style != null) {
      const st = styleValide(body.style);
      if (st !== c.style) { change.push("habillage : " + st); c.style = st; }
    }
    if (!change.length) return json({ ok: true, rien: true, message: "Rien n'a changé." });

    c.corrigeLe = Date.now();
    await store.setJSON("c-" + code, c);

    /* L'index sert la liste du CRM : sans cette mise a jour, l'ecran
       continuerait d'afficher l'ancienne valeur. */
    try {
      const idx = (await store.get("gifts", { type: "json" })) || [];
      const g = idx.find(x => x.code === code);
      if (g) { g.seance = c.seance; g.beneficiaire = c.beneficiaire; await store.setJSON("gifts", idx); }
    } catch (e) {}

    return json({ ok: true, change,
      coupon: { code: prettyGift(c.code), seance: c.seance, beneficiaire: c.beneficiaire,
                message: c.message, style: c.style, formule: c.formule, amount: c.amount } });
  }

  // ---------- renvoyer un bon par email ----------
  /* Meme code, meme lien : on ne regenere rien. Le courrier est celui du
     module partage avec le webhook, pour que l'acheteur recoive exactement
     ce qu'il avait recu la premiere fois. */
  if (body.action === "cadeau-renvoyer") {
    const code = normalizeCode(body.code);
    if (!code) return json({ ok: false, error: "code" }, 400);
    let c = null;
    try { c = await store.get("c-" + code, { type: "json" }); } catch (e) {}
    if (!c || c.kind !== "cadeau") return json({ ok: false, error: "introuvable" }, 404);

    const email = String(body.email || (c.acheteur && c.acheteur.email) || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ ok: false, error: "email", message: "Aucune adresse valable pour ce bon." }, 400);
    }

    const site = (process.env.MBS_SITE_URL || "https://www.mybabyshoot.fr").replace(/\/+$/, "");
    const prenom = String((c.acheteur && c.acheteur.nom) || "").trim().split(/\s+/)[0] || "";
    const commun = {
      prenom, pour: c.beneficiaire || "", mot: c.message || "", label: c.formule || "",
      seance: c.seance, code: c.code, expiresAt: c.expiresAt, montant: c.amount, site,
    };
    const explication = String(body.explication || "").trim().slice(0, 300);
    const corrige = !!body.corrige;
    const html = corrige ? htmlBonCorrige({ ...commun, explication }) : htmlBonCadeau(commun);

    try {
      await sendMail({
        to: email,
        subject: corrige ? "Votre bon cadeau Mybabyshoot (corrigé)" : "Votre bon cadeau Mybabyshoot",
        html,
      });
    } catch (e) {
      return json({ ok: false, error: "mail", message: "L'envoi a échoué : " + (e.message || e) }, 502);
    }
    return json({ ok: true, envoyeA: email });
  }

  // ---------- creation d'un lot ----------
  /* Un seul bon, pour honorer un bon cadeau papier ou d'un ancien site.
     Le montant vient de la formule choisie, jamais du navigateur. */
  if (body.action === "cadeau-manuel") {
    const offre = offreCadeau(body.formule);
    if (!offre) return json({ ok: false, error: "formule" }, 400);
    const beneficiaire = String(body.beneficiaire || "").trim().slice(0, 80);
    if (!beneficiaire) return json({ ok: false, error: "beneficiaire" }, 400);

    const coupon = await createGiftCoupon(store, {
      amount: offre.prix,
      formule: offre.nom,
      seance: offre.duo ? "duo" : "grossesse",
      style: "creme",
      acheteur: { nom: String(body.acheteur || "Bon honoré par le studio").trim().slice(0, 80), email: "" },
      beneficiaire,
      message: String(body.message || "").trim().slice(0, 300),
      sessionId: ""
    });
    if (!coupon) return json({ ok: false, error: "code" }, 500);
    return json({ ok: true, code: prettyGift(coupon.code), montant: coupon.amount,
                  formule: coupon.formule, expiresAt: coupon.expiresAt });
  }

  if (body.action === "creer") {
    const nom = String(body.nom || "Lot").trim().slice(0, 60) || "Lot";
    let nombre = Math.round(Number(body.nombre));
    if (!Number.isFinite(nombre) || nombre < 1) nombre = 1;
    if (nombre > MAX_PAR_LOT) nombre = MAX_PAR_LOT;

    let expiresAt = 0;
    if (body.expiresAt) {
      const d = new Date(String(body.expiresAt) + "T23:59:59");
      if (!isNaN(d.getTime())) expiresAt = d.getTime();
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const now = Date.now();
    const codes = [];
    const vus = new Set();
    while (codes.length < nombre) {
      const c = makeCode(8);
      if (vus.has(c)) continue;
      // on evite d'ecraser un code deja existant
      let dejaPris = null;
      try { dejaPris = await store.get("c-" + c, { type: "json" }); } catch (e) {}
      if (dejaPris) continue;
      vus.add(c);
      codes.push(c);
      await store.setJSON("c-" + c, {
        code: c, batchId: id, amount: COUPON_AMOUNT,
        expiresAt, usedAt: 0, sessionId: "", reservedUntil: 0, disabled: false
      });
    }

    await store.setJSON("batch-" + id, {
      id, nom, amount: COUPON_AMOUNT, expiresAt, createdAt: now, disabled: false, codes, used: []
    });
    let lots = [];
    try { lots = (await store.get("batches", { type: "json" })) || []; } catch (e) {}
    lots.unshift({ id, nom, count: codes.length, amount: COUPON_AMOUNT, expiresAt, createdAt: now, disabled: false });
    await store.setJSON("batches", lots.slice(0, 200));

    return json({ ok: true, id, codes: codes.map(prettyCode) });
  }

  const id = (typeof body.lot === "string" ? body.lot : "").replace(/[^a-z0-9]/gi, "");
  if (!id) return json({ ok: false, error: "lot" }, 400);
  const b = await store.get("batch-" + id, { type: "json" });
  if (!b) return json({ ok: false, error: "notfound" }, 404);

  // ---------- (re)activation ----------
  if (body.action === "desactiver") {
    const off = !!body.off;
    b.disabled = off;
    await store.setJSON("batch-" + id, b);
    for (const c of (b.codes || [])) {
      try {
        const rec = await store.get("c-" + c, { type: "json" });
        if (rec && !rec.usedAt) { rec.disabled = off; await store.setJSON("c-" + c, rec); }
      } catch (e) {}
    }
    let lots = [];
    try { lots = (await store.get("batches", { type: "json" })) || []; } catch (e) {}
    lots = lots.map(l => l.id === id ? { ...l, disabled: off } : l);
    await store.setJSON("batches", lots);
    return json({ ok: true });
  }

  // ---------- suppression ----------
  if (body.action === "supprimer") {
    for (const c of (b.codes || [])) { try { await store.delete("c-" + c); } catch (e) {} }
    try { await store.delete("batch-" + id); } catch (e) {}
    let lots = [];
    try { lots = (await store.get("batches", { type: "json" })) || []; } catch (e) {}
    await store.setJSON("batches", lots.filter(l => l.id !== id));
    return json({ ok: true });
  }

  return json({ ok: false, error: "action" }, 400);
};

export const config = { path: "/.netlify/functions/mbs-coupon-admin" };
