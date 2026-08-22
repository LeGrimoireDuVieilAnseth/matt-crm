// netlify/functions/ml-dispo.js
// Disponibilite d'une date de mariage, pour le site Maison Lumiere.
//
// Public, mais volontairement avare : on ne renvoie qu'un booleen. Jamais
// le nom d'un client, jamais le type d'evenement, jamais la liste des dates
// prises. Quelqu'un qui interroge date par date n'apprend que ce qu'un
// calendrier de reservation lui dirait de toute facon.
import { crmStore, loadData } from "../mbs-lib.mjs";

const BRAND = "maison-lumiere";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);

  const url = new URL(request.url);
  const date = (url.searchParams.get("date") || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "date" }, 400);

  // une date deja passee n'a pas de sens ici
  const aujourdhui = new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  if (date < aujourdhui) return json({ ok: true, libre: false, passee: true });

  let data;
  try { data = await loadData(crmStore()); }
  catch (e) { return json({ ok: false, error: "indisponible" }, 503); }

  // Un mariage occupe la journee entiere : toute seance Maison Lumiere ce
  // jour-la bloque la date, quel que soit son horaire. Les blocages poses
  // par Matt (type "Indispo") comptent aussi, y compris sur une periode.
  const pris = (data.seances || []).some(s => {
    if (s.brand !== BRAND || s.status === "Annulee") return false;
    if (s.dateEnd) return date >= s.date && date <= s.dateEnd;
    return s.date === date;
  });

  return json({ ok: true, libre: !pris });
};

export const config = { path: "/.netlify/functions/ml-dispo" };
