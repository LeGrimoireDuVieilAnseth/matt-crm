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
/* Duree du verrou pose sur le CRENEAU pendant le paiement. Au dela, il se
   relibere et quelqu'un d'autre peut le prendre.

   3 minutes, choisi par Matt : passe ce delai, celle qui n'a pas paye a
   sans doute abandonne, et garder la case fermee plus longtemps fait
   perdre des reservations.

   Contrepartie assumee : une carte avec validation par la banque, ou un
   dossier Klarna, depasse facilement 3 minutes. Si le creneau est repris
   entre-temps et que la premiere paie quand meme, les deux sont
   encaissees. mbs-webhook detecte ce cas, marque la seance "CRÉNEAU EN
   DOUBLE" et pose une tache en priorite haute le jour meme. */
export const LOCK_TTL_MS = 3 * 60 * 1000;

/* La reservation du CODE d'un bon cadeau, elle, reste longue. Elle ne
   bloque rien pour personne d'autre que la porteuse du code, et la
   raccourcir laisserait deux personnes utiliser le meme bon : au webhook,
   consumeCoupon avale l'erreur du second passage sans rien dire. */
export const COUPON_TTL_MS = 20 * 60 * 1000;

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
import { prixTirages } from "./mbs-panier.mjs";

export const PRIX_PHOTO_SUPP = 15;
export const PRIX_ALBUM = 150;
export const TARIFS = {
  simple: { essentielle: 290, confort: 390, prestige: 490 },
  /* Les trois anciens packs a formule unique. Ils ne sont plus vendus, mais
     des bons cadeaux les portent encore : une reservation qui en presente un
     doit continuer de passer. */
  duo:    { essentiel: 590, confort: 690, prestige: 890 }
};

/* Le pack deux seances : une formule par seance, et la remise sur le total.
   L'arrondi descend a la dizaine inferieure, pour ne pas afficher 663 euros
   et pour que la cliente paie toujours un peu moins que les 15 % promis. */
export const REMISE_DUO = 0.125;
export const GAMMES_DUO = ["essentielle", "confort", "prestige"];
export function prixPaireDuo(grossesse, naissance, { noel = false } = {}){
  const a = TARIFS.simple[String(grossesse || "")];
  const b = TARIFS.simple[String(naissance  || "")];
  if (!a || !b) return null;
  const plein = a + b;
  /* Noel 2026 (demande de Matt) : pendant l'offre, le pack passe aux prix de
     Noel, 100 euros de moins sur chaque seance, A LA PLACE de la remise de
     12,5 % ; et 5 photos imprimees sont offertes, livrees chez elle (une
     tache le rappelle a Matt). Meme regle dans app.js. */
  if (noel) return { plein, prix: plein - 2 * REMISE_NOEL.montant, remise: 2 * REMISE_NOEL.montant, noel: true };
  /* Arrondi au centime avant de descendre a la dizaine : sans lui, un
     produit tombant pile sur une dizaine peut valoir 629,9999999 en
     binaire et faire perdre 10 euros. */
  const prix  = Math.floor(Math.round(plein * (1 - REMISE_DUO)) / 10) * 10;
  return { plein, prix, remise: plein - prix };
}

/* LE MINI-SHOOT DU DIMANCHE (demande de Matt, 02/11/2026) : 97 euros,
   45 minutes, 5 photos retouchees, SANS les photos brutes (choix de Matt).
   Le studio est ferme le dimanche : Matt ouvre les quatre dimanches de
   decembre pour cette offre seulement, et elle ne se prend que ces jours-la.
   Grossesse, naissance (tres court pour un nouveau-ne, le site le dit),
   bebe ou famille. Paye en entier a la reservation. Ouvert avec l'habillage
   de Noel, reservation jusqu'au 26 decembre (la derniere seance est le 27).
   Ne se cumule avec aucun code ni bon. Il s'offre en bon cadeau (achete
   pendant l'offre, valable 18 mois en semaine : choix de Matt).
   Hors de TARIFS.simple pour ne pas entrer dans le pack ni dans les bons.
   A garder identique a OFFRE_MINI et GAMMES.mini dans app.js. */
export const OFFRE_MINI = {
  id: "mini", nom: "Mini-shoot spécial Noël", prix: 97, retouches: 5, duree: 45,
  dimanches: ["2026-12-06", "2026-12-13", "2026-12-20", "2026-12-27"],
  creneaux: ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"],
  types: ["grossesse", "naissance", "bebe", "famille"]
};

/* LES PRIX DE NOEL (demande de Matt, 02/11/2026 ; sans code depuis le meme
   jour) : pendant l'offre, 100 euros de moins sur chaque seance unique
   (grossesse, naissance, bebe, famille) et sur son bon cadeau, appliques
   d'office et affiches prix barre sur le site. Le pack a ses propres prix
   de Noel (prixPaireDuo). Ce qui compte, c'est la date de la COMMANDE :
   reservee ou achetee jusqu'au 26 decembre inclus, la seance peut avoir
   lieu en mars. Le 27, retour aux prix habituels.
   La remise demarre quand Matt allume l'habillage de Noel dans son CRM : un
   seul geste lance la deco, l'encadre du site et les prix.
   Un code promo ne s'y ajoute pas (des partenaires distribuent des codes de
   100 euros) ; un bon cadeau reste utilisable, c'est un paiement.
   A garder identique a REMISE_NOEL dans app.js. */
export const REMISE_NOEL = { montant: 100, jusquau: "2026-12-26" };
export async function remiseNoelActive({ jour = todayISOParis(), theme } = {}){
  if (jour > REMISE_NOEL.jusquau) return false;
  if (theme === undefined) {
    try {
      const doc = await getStore({ name: "mbs-theme", consistency: "strong" }).get("actif", { type: "json" });
      theme = doc && doc.theme;
    } catch (e) { theme = ""; }
  }
  return theme === "noel";
}
/* Un creneau du mini-shoot : un des quatre dimanches, une des heures, et
   pas avant le delai habituel (la veille au plus tard). */
export function creneauMiniValide(date, time, jour = todayISOParis()){
  return OFFRE_MINI.dimanches.includes(String(date || "")) && OFFRE_MINI.creneaux.includes(String(time || ""))
    && date >= addDaysISO(jour, MIN_LEAD_DAYS);
}
/* Le chevauchement tient compte des durees : une seance du mini-shoot dure
   45 minutes, une seance habituelle deux heures (DUREE_SEANCE_MIN). Les
   creneaux du dimanche sont espaces d'une heure : deux mini-shoots qui se
   suivent ne se genent pas. */
export function dureeDe(s){ return Number(s && s.duree) || DUREE_SEANCE_MIN; }
export function miniOccupe(data, date, time){
  const debut = minutesDe(time), fin = debut + OFFRE_MINI.duree;
  return (data.seances || []).some(s => {
    if (s.brand !== BRAND || s.date !== date) return false;
    if (s.status === "Annulee" || s.type === "Indispo") return false;
    const d = minutesDe(s.time);
    if (d === null) return true;
    return d < fin && debut < d + dureeDe(s);
  });
}
export function miniLibre(data, date, time, now = Date.now()){
  return creneauMiniValide(date, time) && !miniOccupe(data, date, time)
    && !isLocked(data, date, time, now) && !isBlocked(data, date, time)
    && !mariageConfirme(data, date);
}
export function computeMiniAvailability(data, now = Date.now()){
  return OFFRE_MINI.dimanches.map(date => ({
    date, slots: OFFRE_MINI.creneaux.filter(t => miniLibre(data, date, t, now))
  })).filter(d => d.slots.length);
}

/* Renvoie le prix de la formule, hors frais de deplacement et hors
   remise, ou null si la formule est inconnue. */
export function prixSeance({ section, gamme, gammes, photos, album, tirages, noel = false } = {}){
  let base;
  if (section === "mini") {
    base = gamme === OFFRE_MINI.id ? OFFRE_MINI.prix : null;
  } else if (section === "duo") {
    /* Le pack actuel envoie une formule par seance. L'ancien, a formule
       unique, reste accepte pour les bons cadeaux deja vendus. */
    const paire = gammes ? prixPaireDuo(gammes.grossesse, gammes.naissance, { noel }) : null;
    base = paire ? paire.prix : TARIFS.duo[String(gamme || "")];
  } else {
    base = TARIFS.simple[String(gamme || "")];
  }
  if (!base) return null;
  const n = Math.min(Math.max(parseInt(photos, 10) || 0, 0), 50);
  /* Les tirages commandes des la reservation : leur prix et l'envoi
     viennent de mbs-panier.mjs, comme au comptoir. */
  return base + n * PRIX_PHOTO_SUPP + (album ? PRIX_ALBUM : 0) + prixTirages(tirages).total;
}

// Libelle francais du type de seance (pour l'agenda et les emails).
/* Les types de seance vendus. Liste fermee : ce qui n'y est pas est
   refuse a la reservation plutot que d'arriver mal etiquete dans le CRM,
   sur la facture et dans le mail de la cliente. */
/* "famille" revient le 02/11/2026 : Matt la vend a Noel, et surtout en bon
   cadeau, pour offrir une seance a quelqu'un qui n'attend pas d'enfant. */
export const TYPES_SEANCE = ["grossesse", "naissance", "bebe", "famille", "duo"];
export const typeConnu = (t) => TYPES_SEANCE.includes(String(t || ""));

export function typeLabelFr(type){
  if (type === "duo") return "Grossesse + naissance";
  if (type === "naissance") return "Naissance";
  if (type === "bebe") return "Bébé";
  if (type === "famille") return "Famille";
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
/* Les verrous d'un shooting Matt la Photo (brand "matt-la-photo") ne
   comptent pas ici : Mybabyshoot garde la priorite sur l'agenda (choix de
   Matt, 24/10/2026, voir mlp-resa.mjs). */
export function isLocked(data, date, time, now = Date.now()){
  return data.mbsLocks.some(l =>
    l.brand !== "matt-la-photo" &&
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

/* Le cadeau de Noel du pack : 5 photos imprimees, livrees chez elle. Rien
   ne le rappelait autrement, et l'adresse n'est pas demandee a la
   reservation. Partagee par mbs-checkout (bon de pack) et mbs-webhook. */
export function tachePhotosNoel(name, date, clientId, extra = {}){
  return {
    id: uid(), done: false, priority: "Haute", clientId,
    title: "5 photos imprimées offertes à envoyer à " + name,
    dueDate: date,
    notes: "Cadeau de Noël du pack grossesse + naissance : 5 photos imprimées, livrées chez elle."
      + "\n\nÀ demander : les 5 photos choisies (dans sa galerie) et l'adresse d'envoi"
      + " (nom sur la boîte aux lettres).",
    ...extra
  };
}

export function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
