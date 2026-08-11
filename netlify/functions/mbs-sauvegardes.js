// netlify/functions/mbs-sauvegardes.js
// Consultation et recuperation des sauvegardes du CRM (protege par CRM_KEY).
// - GET ?liste=1         : les instantanes disponibles
// - GET ?jour=AAAA-MM-JJ : le contenu d'un instantane
// - GET ?maintenant=1    : declenche une sauvegarde immediate
import { archives, sauvegarder, JOURS_GARDES } from "../mbs-sauvegarde.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const REQUIRED = process.env.CRM_KEY || "";
const autorise = (request) => !REQUIRED || (request.headers.get("x-crm-key") || "") === REQUIRED;

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);
  if (!autorise(request)) return json({ ok: false, error: "unauthorized" }, 401);

  const url = new URL(request.url);

  if (url.searchParams.get("maintenant")) return json(await sauvegarder());

  if (url.searchParams.get("liste")) {
    let index = [];
    try { index = (await archives().get("index", { type: "json" })) || []; } catch (e) {}
    return json({ ok: true, jours: index, garde: JOURS_GARDES });
  }

  const jour = (url.searchParams.get("jour") || "").replace(/[^0-9-]/g, "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) return json({ ok: false, error: "jour" }, 400);
  let snap = null;
  try { snap = await archives().get("j-" + jour, { type: "json" }); } catch (e) {}
  if (!snap) return json({ ok: false, error: "introuvable" }, 404);
  return json({ ok: true, ...snap });
};

export const config = { path: "/.netlify/functions/mbs-sauvegardes" };
