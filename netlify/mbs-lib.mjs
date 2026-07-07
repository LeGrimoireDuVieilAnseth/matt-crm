// netlify/mbs-lib.mjs
// Bibliotheque partagee pour la reservation Mybabyshoot (brand "mybabyshoot").
// Additif au CRM : on lit et ecrit le meme store Netlify Blobs "studio-crm"
// (cle "data"), mais on ne touche qu'aux enregistrements brand "mybabyshoot".
import { getStore } from "@netlify/blobs";

export const STORE_NAME = "studio-crm";
export const DATA_KEY   = "data";
export const BRAND      = "mybabyshoot";
export const PLACE      = "Studio, 16 chemin du Buisset, 69350 La Mulatiere";

// Ouverture : lundi (1) au samedi (6). Dimanche (0) ferme.
export const OPEN_DAYS = [1, 2, 3, 4, 5, 6];
// Creneaux fixes proposes chaque jour ouvre.
export const SLOTS = ["10:30", "14:30", "18:00"];
// Delai minimum avant une seance : on ne propose pas les dates trop proches.
export const MIN_LEAD_DAYS = 1;
// Horizon de reservation : on propose les creneaux jusqu'a X jours en avant.
export const HORIZON_DAYS = 90;
// Duree du verrou pose pendant le paiement (au dela, le creneau se relibere).
export const LOCK_TTL_MS = 20 * 60 * 1000;

// Acompte selon le total compose : 190 euros des 590 euros, sinon 90.
export function acompteFor(total){
  return Number(total) >= 590 ? 190 : 90;
}

// Libelle francais du type de seance (pour l'agenda et les emails).
export function typeLabelFr(type){
  if (type === "duo") return "Grossesse + naissance";
  if (type === "naissance") return "Naissance";
  return "Grossesse";
}

// --- Dates (robustes au fuseau : le serveur Netlify tourne en UTC) ---

// Date du jour a Paris, au format "AAAA-MM-JJ".
export function todayISOParis(){
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

// Jour de la semaine (0=dim .. 6=sam) d'une date "AAAA-MM-JJ", sans piege de fuseau.
export function weekdayOf(iso){
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Ajoute n jours a une date "AAAA-MM-JJ" et renvoie une date "AAAA-MM-JJ".
export function addDaysISO(iso, n){
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function isValidSlot(date, time){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return false;
  if (!SLOTS.includes(time)) return false;
  if (!OPEN_DAYS.includes(weekdayOf(date))) return false;
  return true;
}

// --- Store ---

export function crmStore(){
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export async function loadData(store){
  const data = (await store.get(DATA_KEY, { type: "json", consistency: "strong" })) || {};
  data.clients   = data.clients   || [];
  data.seances   = data.seances   || [];
  data.paiements = data.paiements || [];
  data.taches    = data.taches    || [];
  data.mbsLocks  = data.mbsLocks  || []; // verrous temporaires de reservation Mybabyshoot
  return data;
}

// Retire les verrous expires. Renvoie true si quelque chose a change.
export function pruneLocks(data, now = Date.now()){
  const before = data.mbsLocks.length;
  data.mbsLocks = data.mbsLocks.filter(l => Number(l.expiresAt) > now);
  return data.mbsLocks.length !== before;
}

// Un creneau (date, time) est-il deja pris par une seance confirmee Mybabyshoot ?
export function isBooked(data, date, time){
  return data.seances.some(s =>
    s.brand === BRAND &&
    s.date === date &&
    s.time === time &&
    s.status !== "Annulee"
  );
}

// Un creneau est-il verrouille (paiement en cours) et non expire ?
export function isLocked(data, date, time, now = Date.now()){
  return data.mbsLocks.some(l =>
    l.date === date && l.time === time && Number(l.expiresAt) > now
  );
}

// Un creneau est-il bloque par Matt (indisponibilite : mariage, vacances...) ?
// Un blocage est stocke comme une seance brand "mybabyshoot" de type "Indispo"
// (ainsi il est preserve et synchronise par le CRM comme les autres seances).
//   time vide         -> journee entiere bloquee
//   time renseigne    -> seul ce creneau est bloque
//   dateEnd renseigne -> periode date..dateEnd bloquee (vacances)
export function isBlocked(data, date, time){
  return data.seances.some(s =>
    s.brand === BRAND && s.type === "Indispo" && s.status !== "Annulee" &&
    (s.dateEnd ? (date >= s.date && date <= s.dateEnd) : date === s.date) &&
    (!s.time || s.time === time)
  );
}

// Un creneau est-il libre a la reservation ?
export function isFree(data, date, time, now = Date.now()){
  return isValidSlot(date, time) && !isBooked(data, date, time)
    && !isLocked(data, date, time, now) && !isBlocked(data, date, time);
}

// Calcule les jours et creneaux disponibles a partir des donnees.
export function computeAvailability(data, now = Date.now()){
  const today = todayISOParis();
  const start = addDaysISO(today, MIN_LEAD_DAYS);
  const days = [];
  for (let i = 0; i < HORIZON_DAYS; i++){
    const date = addDaysISO(start, i);
    if (!OPEN_DAYS.includes(weekdayOf(date))) continue;
    const slots = SLOTS.filter(t => !isBooked(data, date, t) && !isLocked(data, date, t, now) && !isBlocked(data, date, t));
    if (slots.length) days.push({ date, slots });
  }
  return days;
}

export function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
