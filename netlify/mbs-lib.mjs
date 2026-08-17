// netlify/mbs-lib.mjs
// Bibliotheque partagee pour la reservation Mybabyshoot (brand "mybabyshoot").
// Additif au CRM : on lit et ecrit le meme store Netlify Blobs "studio-crm"
// (cle "data"), mais on ne touche qu'aux enregistrements brand "mybabyshoot".
import { getStore } from "@netlify/blobs";

export const STORE_NAME = "studio-crm";
export const DATA_KEY   = "data";
export const BRAND      = "mybabyshoot";
export const PLACE      = "Studio, 16 chemin du Buisset, 69350 La Mulatière";

// Ouverture : lundi (1) au samedi (6). Dimanche (0) ferme.
export const OPEN_DAYS = [1, 2, 3, 4, 5, 6];
// Creneaux fixes proposes chaque jour ouvre.
export const SLOTS = ["10:30", "14:30", "18:00"];
// Delai minimum avant une seance : on ne propose pas les dates trop proches.
export const MIN_LEAD_DAYS = 1;
// Horizon de reservation : on propose les creneaux jusqu'a X jours en avant.
// Une annee complete de reservation. A 90 jours, plus rien n'etait
// reservable au-dela de trois mois : les clientes qui s'y prennent tot,
// typiquement en debut de grossesse, ne trouvaient aucune date.
export const HORIZON_DAYS = 365;
// Duree du verrou pose pendant le paiement (au dela, le creneau se relibere).
export const LOCK_TTL_MS = 20 * 60 * 1000;

// Acompte selon le total compose : 190 euros des 590 euros, sinon 90.
export function acompteFor(total){
  return Number(total) >= 590 ? 190 : 90;
}

/* ---------------------------------------------------------------
   TARIFS DES SEANCES

   C'est ici la reference. Le navigateur affiche un prix, il ne le
   decide pas : le serveur recalcule toujours a partir de la formule
   choisie. Sans ca, n'importe qui pouvait annoncer le montant de son
   choix au moment de payer.

   A garder identique a GAMMES dans "1 - Site Mybabyshoot/js/app.js".
   Si les deux divergent, la reservation est refusee avec un message
   demandant de recharger la page, plutot que de facturer autre chose
   que ce que la cliente a vu.
   --------------------------------------------------------------- */
export const PRIX_PHOTO_SUPP = 20;
export const PRIX_ALBUM = 140;
export const TARIFS = {
  simple: { essentielle: 290, confort: 390, prestige: 490 },
  duo:    { essentiel: 590, confort: 690, prestige: 890 }
};

/* Renvoie le prix de la formule, hors frais de deplacement et hors
   remise, ou null si la formule est inconnue. */
export function prixSeance({ section, gamme, photos, album } = {}){
  const table = TARIFS[section === "duo" ? "duo" : "simple"];
  const base = table[String(gamme || "")];
  if (!base) return null;
  const n = Math.min(Math.max(parseInt(photos, 10) || 0, 0), 50);
  return base + n * PRIX_PHOTO_SUPP + (album ? PRIX_ALBUM : 0);
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
// Duree pendant laquelle une seance occupe le studio. Les creneaux du site
// sont espaces d'au moins 3h30, donc une seance posee sur l'un d'eux n'en
// bloquera jamais deux.
export const DUREE_SEANCE_MIN = 120;

export function minutesDe(t){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Un creneau est-il deja pris par une seance ?
// L'heure d'une seance saisie a la main dans le CRM ne tombe pas forcement
// sur un creneau du site (une reservation reprise d'un ancien agenda, par
// exemple) : on bloque donc tout creneau qui chevauche la seance, et pas
// seulement celui qui a exactement la meme heure. Sans heure, c'est la
// journee entiere qui est prise, comme pour un blocage.
// Les "Indispo" sont laissees a isBlocked, qui gere aussi les periodes.
export function isBooked(data, date, time){
  const debutCreneau = minutesDe(time);
  return data.seances.some(s => {
    if (s.brand !== BRAND || s.date !== date) return false;
    if (s.status === "Annulee" || s.type === "Indispo") return false;
    const debutSeance = minutesDe(s.time);
    if (debutSeance === null) return true;
    if (debutCreneau === null) return false;
    return Math.abs(debutSeance - debutCreneau) < DUREE_SEANCE_MIN;
  });
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

/* Un mariage dont l'acompte est encaisse bloque la journee entiere de la
   reservation Mybabyshoot. L'inverse n'est pas vrai : une seance grossesse
   deja posee ne bloque pas un mariage, Matt peut la decaler en appelant sa
   cliente, ce qu'il ne pourrait pas faire d'un mariage.

   On ne cree aucun blocage en double : la seance de mariage sert de source
   unique. Si elle change de date ou est annulee, la journee se relibere
   toute seule. */
export function mariageConfirme(data, date){
  const mariages = (data.seances || []).filter(s =>
    s.brand === "maison-lumiere" && s.status !== "Annulee" && s.type !== "Indispo" &&
    (s.dateEnd ? (date >= s.date && date <= s.dateEnd) : s.date === date)
  );
  if (!mariages.length) return false;

  // "acompte recu" au sens du CRM : un paiement existe et n'est plus en attente
  return mariages.some(m => (data.paiements || []).some(p =>
    p.brand === "maison-lumiere" &&
    p.clientId && p.clientId === m.clientId &&
    p.statut && p.statut !== "En attente"
  ));
}

// Un creneau est-il libre a la reservation ?
export function isFree(data, date, time, now = Date.now()){
  return isValidSlot(date, time) && !isBooked(data, date, time)
    && !isLocked(data, date, time, now) && !isBlocked(data, date, time)
    && !mariageConfirme(data, date);
}

// Calcule les jours et creneaux disponibles a partir des donnees.
export function computeAvailability(data, now = Date.now()){
  const today = todayISOParis();
  const start = addDaysISO(today, MIN_LEAD_DAYS);
  const days = [];
  for (let i = 0; i < HORIZON_DAYS; i++){
    const date = addDaysISO(start, i);
    if (!OPEN_DAYS.includes(weekdayOf(date))) continue;
    if (mariageConfirme(data, date)) continue;   // journee prise par un mariage
    const slots = SLOTS.filter(t => !isBooked(data, date, t) && !isLocked(data, date, t, now) && !isBlocked(data, date, t));
    if (slots.length) days.push({ date, slots });
  }
  return days;
}

export function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
