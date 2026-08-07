// netlify/functions/mbs-coupon-admin.js
// Gestion des codes de reduction depuis le CRM (protege par CRM_KEY).
// - GET  ?lots=1        : liste des lots
// - GET  ?lot=ID        : detail d'un lot (chaque code + son etat)
// - POST {action:"creer", nom, nombre, expiresAt}  : genere un lot de codes
// - POST {action:"desactiver", lot, off}           : (re)active un lot entier
// - POST {action:"supprimer", lot}                 : supprime le lot et ses codes
import { couponStore, makeCode, prettyCode, COUPON_AMOUNT } from "../mbs-coupons.mjs";

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

  // ---------- creation d'un lot ----------
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
