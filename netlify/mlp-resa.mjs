// netlify/mlp-resa.mjs
/* LA RESERVATION DES SHOOTINGS MATT LA PHOTO (24/10/2026).

   Demande de Matt : "exactement le meme fonctionnement que Mybabyshoot",
   avec les formules portrait. On reprend donc tout le chemin de
   mbs-lib / mbs-checkout / mbs-webhook : calendrier, verrou de 3 minutes
   sur le creneau pendant le paiement, acompte par carte ou tout en 3 fois
   avec Klarna, deplacement calcule depuis l'adresse, relance si le
   paiement n'aboutit pas, puis fiche, seance, paiement, facture et mail
   dans le CRM. Mais tout est au nom de Matt la Photo (son Stripe, sa
   serie de factures MLP, sa boite mail), et rien ne se melange avec
   Mybabyshoot.

   L'AGENDA, ET LA PRIORITE A MYBABYSHOOT (choix de Matt) : "les
   reservations de Mybabyshoot ont la priorite, mais n'annulent pas la
   possibilite de reserver avec Matt la Photo, je pourrais voir avec eux
   pour decaler". Donc :
     - une seance Mybabyshoot NE bloque PAS un creneau de shooting ;
     - un shooting ne bloque JAMAIS un creneau Mybabyshoot (ni sa seance,
       ni son verrou de paiement, voir isLocked dans mbs-lib) ;
     - quand les deux tombent en meme temps, le CRM le signale (note et
       rappel urgent) pour que Matt decale le shooting.
   Ce qui bloque un shooting : un autre shooting, une indisponibilite
   posee par Matt dans le CRM, et un mariage Maison Lumiere confirme
   (comme pour Mybabyshoot).

   LE PRIX EST CALCULE ICI, JAMAIS RECU DU NAVIGATEUR. */
import { BRAND as BRAND_MBS, LOCK_TTL_MS, OPEN_DAYS, MIN_LEAD_DAYS, HORIZON_DAYS, DUREE_SEANCE_MIN,
         acompteFor, todayISOParis, weekdayOf, addDaysISO, minutesDe, mariageConfirme } from "./mbs-lib.mjs";
import { prixPhotos, PRIX_PHOTO, PRIX_PHOTO_DEGRESSIF, PHOTOS_DEGRESSIF_DES } from "./mbs-panier.mjs";

export const BRAND_MLP = "matt-la-photo";

/* Les formules portrait, prix donnes par Matt le 24/10/2026. Les
   retouches reprennent celles de Mybabyshoot (a confirmer par Matt) :
   null = "toutes les plus belles". A garder identique aux cartes de
   "7 - Site Matt la Photo/shooting.html" : si les deux divergent, la
   reservation est refusee avec un message demandant de recharger la page.

   L'OFFRE MATT LA PHOTO (video: true), demande de Matt le 24/10/2026 : le
   shooting, et en plus Matt tourne une video dans son format habituel et la
   publie sur TikTok et Instagram. La personne gagne en visibilite, Matt a
   du contenu : le prix est plus doux. Elle remplace l'Essentielle a 190 EUR.
   On ne peut la reserver qu'en donnant son accord pour etre filme(e) et
   publie(e) (consentVideo, verifie par le serveur et date dans le CRM). */
export const FORMULES_MLP = {
  video:    { nom: "L'offre Matt la Photo", prix: 150, retouches: 5, video: true },
  confort:  { nom: "Confort",  prix: 250, retouches: 15 },
  prestige: { nom: "Prestige", prix: 350, retouches: null }
};
export const retouchesTexte = (f) => f.retouches ? f.retouches + " photos retouchées" : "toutes les plus belles photos retouchées";
/* Ce que la formule comprend, en une ligne (facture, mail, CRM). */
export const contenuFormule = (f) => (f.video ? "shooting + vidéo publiée sur TikTok et Instagram, " : "") + retouchesTexte(f);

/* Un creneau toutes les 1 h 30 (choix de Matt), du lundi au samedi comme
   Mybabyshoot. Une seance tient dans son creneau. */
export const SLOTS_MLP = ["09:00", "10:30", "12:00", "13:30", "15:00", "16:30", "18:00"];
export const DUREE_SHOOTING_MIN = 90;
export const PHOTOS_EN_PLUS_MAX = 50;
export const GRILLE_PHOTOS = { prix: PRIX_PHOTO, degressif: PRIX_PHOTO_DEGRESSIF, des: PHOTOS_DEGRESSIF_DES };

export function isValidSlotMlp(date, time) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || "") && SLOTS_MLP.includes(time) && OPEN_DAYS.includes(weekdayOf(date));
}

/* Le prix de la seance hors deplacement, ou null si la formule est inconnue. */
export function prixShooting({ gamme, photos } = {}) {
  const f = FORMULES_MLP[String(gamme || "")];
  if (!f) return null;
  const n = Math.min(Math.max(parseInt(photos, 10) || 0, 0), PHOTOS_EN_PLUS_MAX);
  return { base: f.prix, photos: n, prixPhotos: prixPhotos(n), total: f.prix + prixPhotos(n) };
}
/* Meme regle d'acompte que Mybabyshoot : 90 euros, 190 a partir de 590. */
export const acompteMlp = (totalPlein) => acompteFor(totalPlein);

const ecart = (a, b) => { const x = minutesDe(a), y = minutesDe(b); return x === null || y === null ? null : Math.abs(x - y); };

/* Un autre shooting deja sur ce creneau (ou qui le chevauche). */
export function shootingSur(data, date, time) {
  return (data.seances || []).find(s => {
    if (s.brand !== BRAND_MLP || s.date !== date || s.status === "Annulee" || s.type === "Indispo") return false;
    const e = ecart(s.time, time);
    return e === null ? true : e < DUREE_SHOOTING_MIN;
  }) || null;
}

/* Une seance Mybabyshoot en meme temps : elle ne bloque pas (priorite a
   Mybabyshoot, Matt decalera le shooting), mais on la signale. */
export function seanceMybabyshootSur(data, date, time) {
  return (data.seances || []).find(s => {
    if (s.brand !== BRAND_MBS || s.date !== date || s.status === "Annulee" || s.type === "Indispo") return false;
    const e = ecart(s.time, time);
    return e === null ? true : e < DUREE_SEANCE_MIN;
  }) || null;
}

/* L'inverse, pour le webhook de Mybabyshoot : un shooting deja pose au
   moment ou une seance Mybabyshoot est reservee (c'est lui qu'on decale). */
export function shootingQuiChevauche(data, date, time) {
  return (data.seances || []).find(s => {
    if (s.brand !== BRAND_MLP || s.date !== date || s.status === "Annulee" || s.type === "Indispo") return false;
    const e = ecart(s.time, time);
    return e === null ? true : e < DUREE_SEANCE_MIN;
  }) || null;
}

/* Matt indisponible (vacances, journee bloquee) : les blocages du CRM sont
   des seances "Indispo" de la marque mybabyshoot. Une journee ou une
   periode bloque tout ; un creneau bloque les shootings qui le chevauchent. */
export function bloquePourMlp(data, date, time) {
  return (data.seances || []).some(s => {
    if (s.brand !== BRAND_MBS || s.type !== "Indispo" || s.status === "Annulee") return false;
    if (!(s.dateEnd ? (date >= s.date && date <= s.dateEnd) : date === s.date)) return false;
    if (!s.time) return true;
    const e = ecart(s.time, time);
    return e !== null && e < DUREE_SEANCE_MIN;
  });
}

/* Les verrous de paiement des shootings portent la marque : ceux de
   Mybabyshoot ne les concernent pas, et inversement (mbs-lib, isLocked). */
export const verrouMlp = (data, date, time, now = Date.now()) => (data.mbsLocks || []).some(l =>
  l.brand === BRAND_MLP && l.date === date && l.time === time && Number(l.expiresAt) > now);

export function isFreeMlp(data, date, time, now = Date.now()) {
  return isValidSlotMlp(date, time) && !shootingSur(data, date, time) && !verrouMlp(data, date, time, now)
    && !bloquePourMlp(data, date, time) && !mariageConfirme(data, date);
}

export function disponibilitesMlp(data, now = Date.now()) {
  const debut = addDaysISO(todayISOParis(), MIN_LEAD_DAYS);
  const days = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const date = addDaysISO(debut, i);
    if (!OPEN_DAYS.includes(weekdayOf(date)) || mariageConfirme(data, date)) continue;
    const slots = SLOTS_MLP.filter(t => isFreeMlp(data, date, t, now));
    if (slots.length) days.push({ date, slots });
  }
  return days;
}

export { LOCK_TTL_MS };
