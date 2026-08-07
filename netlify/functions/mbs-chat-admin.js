// netlify/functions/mbs-chat-admin.js
// Cote CRM : lecture et gestion des conversations du chat du site.
// Protege par CRM_KEY (meme mecanisme que store-crm).
// - GET  ?list=1        : liste des conversations (index)
// - GET  ?conv=ID       : une conversation complete (et marque lue)
// - POST {action:"reply", conv, text} : Matt repond (passe en mode "matt")
// - POST {action:"mode", conv, mode}  : bascule "ia" / "matt"
// - POST {action:"delete", conv}      : supprime la conversation
import { getStore } from "@netlify/blobs";
import { normBrand, idxKey, consKey } from "../chat-brands.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const REQUIRED = process.env.CRM_KEY || "";
const authorized = (request) => !REQUIRED || (request.headers.get("x-crm-key") || "") === REQUIRED;

async function updateIndex(store, conv, removed) {
  const brand = normBrand(conv.brand);
  let index = [];
  try { index = (await store.get(idxKey(brand), { type: "json" })) || []; } catch (e) {}
  index = index.filter(x => x.id !== conv.id);
  if (!removed) {
    const last = conv.messages[conv.messages.length - 1];
    const v = conv.visiteur || {};
    index.unshift({
      id: conv.id,
      brand,
      nom: [v.prenom, v.nom].filter(Boolean).join(" ").trim(),
      tel: v.tel || "",
      updatedAt: conv.updatedAt,
      mode: conv.mode,
      flagged: !!conv.flagged,
      unread: conv.unread || 0,
      preview: last ? String(last.content).slice(0, 90) : ""
    });
  }
  await store.setJSON(idxKey(brand), index.slice(0, 100));
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);

  const store = getStore({ name: "mbs-chat", consistency: "strong" });

  if (request.method === "GET") {
    const url = new URL(request.url);
    const brandQ = normBrand(url.searchParams.get("brand"));
    if (url.searchParams.get("consignes")) {
      let txt = "";
      try { txt = (await store.get(consKey(brandQ))) || ""; } catch (e) {}
      return json({ ok: true, consignes: txt });
    }
    if (url.searchParams.get("list")) {
      let index = [];
      try { index = (await store.get(idxKey(brandQ), { type: "json" })) || []; } catch (e) {}
      return json({ ok: true, list: index });
    }
    const id = (url.searchParams.get("conv") || "").replace(/[^a-z0-9]/gi, "");
    if (!id) return json({ ok: false, error: "conv" }, 400);
    const conv = await store.get("conv-" + id, { type: "json" });
    if (!conv) return json({ ok: false, error: "notfound" }, 404);
    if (conv.unread) {
      conv.unread = 0;
      conv.updatedAt = conv.updatedAt || Date.now();
      await store.setJSON("conv-" + id, conv);
      await updateIndex(store, conv);
    }
    return json({ ok: true, conv });
  }

  if (request.method !== "POST")
    return new Response("Methode non supportee", { status: 405, headers: cors });

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  // consignes ecrites par Matt : injectees dans le cerveau de l'assistant
  if (body.action === "consignes") {
    const txt = (typeof body.text === "string" ? body.text : "").slice(0, 6000);
    await store.set(consKey(normBrand(body.brand)), txt);
    return json({ ok: true });
  }

  const id = (typeof body.conv === "string" ? body.conv : "").replace(/[^a-z0-9]/gi, "");
  if (!id) return json({ ok: false, error: "conv" }, 400);
  const conv = await store.get("conv-" + id, { type: "json" });
  if (!conv) return json({ ok: false, error: "notfound" }, 404);

  if (body.action === "reply") {
    const text = (typeof body.text === "string" ? body.text : "").trim().slice(0, 1000);
    if (!text) return json({ ok: false, error: "text" }, 400);
    conv.messages.push({ role: "matt", content: text, t: Date.now() });
    conv.mode = "matt"; // repondre = reprendre la main
    conv.flagged = false;
    conv.unread = 0;
    conv.updatedAt = Date.now();
    if (conv.messages.length > 80) conv.messages = conv.messages.slice(-80);
    await store.setJSON("conv-" + id, conv);
    await updateIndex(store, conv);
    return json({ ok: true, conv });
  }

  if (body.action === "mode") {
    conv.mode = body.mode === "matt" ? "matt" : "ia";
    if (conv.mode === "ia") conv.flagged = false;
    conv.updatedAt = Date.now();
    await store.setJSON("conv-" + id, conv);
    await updateIndex(store, conv);
    return json({ ok: true, conv });
  }

  if (body.action === "delete") {
    await store.delete("conv-" + id);
    await updateIndex(store, conv, true);
    return json({ ok: true });
  }

  return json({ ok: false, error: "action" }, 400);
};

export const config = { path: "/.netlify/functions/mbs-chat-admin" };
