// netlify/mbs-sauvegarde.mjs
// Instantanes quotidiens des donnees du CRM (clients, seances, paiements,
// taches), gardes 30 jours dans un store SEPARE de celui du CRM : une fausse
// manoeuvre dans l'application ne peut pas les effacer.
import { getStore } from "@netlify/blobs";

export const JOURS_GARDES = 30;

export const donnees  = () => getStore({ name: "studio-crm",  consistency: "strong" });
export const archives = () => getStore({ name: "crm-backups", consistency: "strong" });

export function jourParis(d = new Date()) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

/* Prend un instantane du jour et purge les plus anciens. */
export async function sauvegarder() {
  const data = await donnees().get("data", { type: "json", consistency: "strong" });
  if (!data) return { ok: false, raison: "aucune_donnee" };

  const arc = archives();
  const jour = jourParis();
  const resume = {
    jour, at: Date.now(),
    clients:   (data.clients   || []).length,
    seances:   (data.seances   || []).length,
    paiements: (data.paiements || []).length,
    taches:    (data.taches    || []).length
  };
  await arc.setJSON("j-" + jour, { resume, data });

  let index = [];
  try { index = (await arc.get("index", { type: "json" })) || []; } catch (e) {}
  index = index.filter(e => e.jour !== jour);
  index.unshift(resume);
  index.sort((a, b) => b.jour.localeCompare(a.jour));

  for (const e of index.slice(JOURS_GARDES)) {
    try { await arc.delete("j-" + e.jour); } catch (_) {}
  }
  index = index.slice(0, JOURS_GARDES);
  await arc.setJSON("index", index);

  return { ok: true, ...resume, conserves: index.length };
}
