// netlify/functions/mbs-galerie.js
// Ordre des photos de la galerie du site, choisi par Matt depuis son CRM.
//
// - GET  (public)          : l'ordre, lu par le site a chaque chargement
// - POST (protege CRM_KEY) : enregistre le nouvel ordre
//
// Le site garde sa propre liste en dur : si ce service ne repond pas, ou
// s'il n'y a pas encore d'ordre enregistre, la galerie s'affiche quand meme.
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const REQUIRED = process.env.CRM_KEY || "";
const autorise = (request) => !REQUIRED || (request.headers.get("x-crm-key") || "") === REQUIRED;

const store = () => getStore({ name: "mbs-galerie", consistency: "strong" });

// Une photo est soit un chemin du site (images/xxx.jpg), soit un identifiant
// Wix. On borne la taille pour qu'une requete forgee ne remplisse pas le store.
const PHOTO_OK = /^[A-Za-z0-9_~./-]{4,120}$/;
const MAX_PHOTOS = 200;

function nettoyer(liste) {
  if (!Array.isArray(liste)) return [];
  const vues = new Set();
  const out = [];
  for (const x of liste) {
    const v = String(x || "").trim();
    if (!PHOTO_OK.test(v) || vues.has(v)) continue;
    vues.add(v);
    out.push(v);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (request.method === "GET") {
    let doc = null;
    try { doc = await store().get("ordre", { type: "json" }); } catch (e) {}
    return json({
      ok: true,
      ordre: (doc && doc.ordre) || [],
      masquees: (doc && doc.masquees) || [],
      maj: (doc && doc.maj) || 0
    });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  if (!autorise(request)) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  const doc = {
    ordre: nettoyer(body.ordre),
    masquees: nettoyer(body.masquees),
    maj: Date.now()
  };
  if (!doc.ordre.length) return json({ ok: false, error: "vide" }, 400);

  await store().setJSON("ordre", doc);
  return json({ ok: true, total: doc.ordre.length, masquees: doc.masquees.length });
};

export const config = { path: "/.netlify/functions/mbs-galerie" };
