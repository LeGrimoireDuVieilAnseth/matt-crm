// netlify/functions/mbs-theme.js
// Habillage du site, choisi par Matt depuis son CRM.
//
// - GET  (public)          : le theme actif, lu par le site a chaque visite
// - POST (protege CRM_KEY) : change le theme
//
// Le site part toujours du theme normal si ce service ne repond pas :
// une decoration ne doit jamais empecher le site de s'afficher.
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

const THEMES = ["normal", "noel"];
const store = () => getStore({ name: "mbs-theme", consistency: "strong" });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (request.method === "GET") {
    let doc = null;
    try { doc = await store().get("actif", { type: "json" }); } catch (e) {}
    const theme = doc && THEMES.includes(doc.theme) ? doc.theme : "normal";
    return json({ ok: true, theme, maj: (doc && doc.maj) || 0 });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  if (!autorise(request)) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  const theme = String(body.theme || "");
  if (!THEMES.includes(theme)) return json({ ok: false, error: "theme" }, 400);

  await store().setJSON("actif", { theme, maj: Date.now() });
  return json({ ok: true, theme });
};

export const config = { path: "/.netlify/functions/mbs-theme" };
