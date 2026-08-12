// netlify/functions/mbs-stats.js
// Mesure d'audience maison du site Mybabyshoot.
//
// POST (public, appele par le site)  : enregistre un evenement
// GET  (protege par CRM_KEY)         : renvoie les compteurs pour le CRM
//
// Aucun identifiant de visiteur n'est stocke ici. Le site sait lui-meme
// s'il a deja ete compte aujourd'hui et ne l'annonce qu'une fois : le
// serveur ne manipule que des compteurs. Rien n'est transmis a un tiers,
// rien ne permet de suivre quelqu'un d'un site a l'autre.
import { getStore } from "@netlify/blobs";

const JOURS_GARDES = 400;   // un peu plus d'un an, pour comparer les saisons

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const store = () => getStore({ name: "mbs-stats", consistency: "strong" });
const REQUIRED = process.env.CRM_KEY || "";
const autorise = (request) => !REQUIRED || (request.headers.get("x-crm-key") || "") === REQUIRED;

/* Jour courant a Paris : sans ca, tout ce qui se passe apres minuit heure
   francaise serait compte sur la veille en hiver comme en ete. */
function jourParis(d = new Date()) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

const vide = (jour) => ({
  jour, visiteurs: 0, vues: 0, duree: 0, mesures: 0, clics: {}, sources: {}
});

/* D'ou vient la visite. On ne garde qu'une categorie, jamais l'adresse
   complete de provenance. */
function categorieSource(ref, utm) {
  const u = String(utm || "").toLowerCase();
  if (u.includes("google") || u === "cpc" || u === "ads") return "Google Ads";
  if (u.includes("insta")) return "Instagram";
  if (u.includes("tiktok")) return "TikTok";
  const r = String(ref || "").toLowerCase();
  if (!r) return "Direct";
  if (r.includes("google")) return "Google";
  if (r.includes("instagram")) return "Instagram";
  if (r.includes("tiktok")) return "TikTok";
  if (r.includes("facebook")) return "Facebook";
  if (r.includes("bing") || r.includes("duckduck") || r.includes("ecosia")) return "Autre moteur";
  if (r.includes("mybabyshoot")) return "Direct";
  return "Autre site";
}

/* Nettoie une etiquette de clic : on ne veut ni texte libre, ni volume. */
function etiquette(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

async function purger(s) {
  let index = [];
  try { index = (await s.get("index", { type: "json" })) || []; } catch (e) {}
  if (index.length <= JOURS_GARDES) return index;
  const trop = index.slice(0, index.length - JOURS_GARDES);
  for (const j of trop) { try { await s.delete("j-" + j); } catch (e) {} }
  return index.slice(-JOURS_GARDES);
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  /* ---------- lecture par le CRM ---------- */
  if (request.method === "GET") {
    if (!autorise(request)) return json({ ok: false, error: "unauthorized" }, 401);
    const s = store();
    let index = [];
    try { index = (await s.get("index", { type: "json" })) || []; } catch (e) {}

    const url = new URL(request.url);
    const depuis = (url.searchParams.get("depuis") || "").slice(0, 10);
    const voulus = depuis ? index.filter(j => j >= depuis) : index;

    const jours = [];
    for (const j of voulus) {
      try {
        const d = await s.get("j-" + j, { type: "json" });
        if (d) jours.push(d);
      } catch (e) {}
    }
    return json({ ok: true, jours });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  /* ---------- enregistrement depuis le site ---------- */
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const jour = jourParis();
  const s = store();

  let d = null;
  try { d = await s.get("j-" + jour, { type: "json" }); } catch (e) {}
  if (!d) d = vide(jour);
  // compat : un enregistrement ecrit par une version anterieure
  d.clics = d.clics || {};
  d.sources = d.sources || {};

  if (body.type === "vue") {
    d.vues++;
    if (body.nouveau) {
      d.visiteurs++;
      const src = categorieSource(body.ref, body.utm);
      d.sources[src] = (d.sources[src] || 0) + 1;
    }
  } else if (body.type === "duree") {
    // borne haute : un onglet laisse ouvert toute la nuit fausserait la moyenne
    const sec = Math.min(Math.max(Number(body.secondes) || 0, 0), 1800);
    if (sec >= 3) { d.duree += sec; d.mesures++; }
  } else if (body.type === "clic") {
    const e = etiquette(body.quoi);
    if (e) d.clics[e] = (d.clics[e] || 0) + 1;
  } else {
    return json({ ok: true, ignore: true });
  }

  try { await s.setJSON("j-" + jour, d); } catch (e) {}

  let index = await purger(s);
  if (!index.includes(jour)) {
    index = index.concat([jour]).sort();
    try { await s.setJSON("index", index); } catch (e) {}
  }

  return json({ ok: true });
};

export const config = { path: "/.netlify/functions/mbs-stats" };
