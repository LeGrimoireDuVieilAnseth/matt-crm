// netlify/mbs-galeries.mjs
/* LA GALERIE LEGERE.

   Matt quitte Pelli.io. Il ne voulait pas d'une vraie galerie maison (voir
   la memoire "galerie privee ecartee" : le SAV des telechargements), mais
   d'une "fausse galerie" :
     - une page aux couleurs de Mybabyshoot ou la cliente REGARDE ses photos,
       en apercus legers ;
     - un bouton "tout telecharger" qui mene a un WeTransfer ou un
       SwissTransfer : la pleine qualite ne passe jamais par ici ;
     - des coeurs pour choisir les photos a retoucher, au-dela de la formule
       elles se paient au tarif du comptoir ;
     - des tirages, payes tout de suite ;
     - la selection qui remonte dans le CRM, avec les numeros des photos.

   CE QUI EST STOCKE : pour chaque photo, une vignette (~25 Ko) et un apercu
   (~110 Ko), fabriques dans le navigateur de Matt au moment de preparer la
   galerie. Jamais l'original. Le tout est efface trois mois apres la
   creation (mbs-galeries-nettoyage).

   POURQUOI SI LEGER : chez Netlify, la bande passante coute 20 credits par
   Go, et l'offre gratuite plafonne a 300 credits par mois, sans rachat
   possible. Les images sont servies avec un cache navigateur d'une semaine :
   une cliente qui revient ne les retelecharge pas.

   CE QUI N'EST PAS STOCKE ICI : la commande payee. Une commande passee depuis
   la galerie DEVIENT un lien de paiement (mbs-liens), et suit le meme chemin
   jusqu'au bout : webhook, facture, ligne de recette, rappel des tirages. */
import { getStore } from "@netlify/blobs";
import { makeCode } from "./mbs-coupons.mjs";

/* "mbs-galeries-clientes", et non "mbs-galeries" : le store "mbs-galerie"
   existe deja, il garde l'ordre des photos de la galerie PUBLIQUE du site.
   Deux noms a une lettre pres, c'est une confusion assuree. */
export const GALERIE_STORE = "mbs-galeries-clientes";
export const galerieStore = () => getStore({ name: GALERIE_STORE, consistency: "strong" });

/* Les retouches comprises dans chaque formule. 0 = sans limite (Prestige :
   les coeurs sont facultatifs, ils guident Matt sans rien declencher).
   DOIT rester egal aux "retouchees" de GAMMES.simple dans js/app.js du
   site : un test compare les deux. */
export const QUOTA = { essentielle: 5, confort: 15, prestige: 0 };
export const NOM_FORMULE = { essentielle: "Essentielle", confort: "Confort", prestige: "Prestige" };

export const DUREE_MOIS = 3;
export const PHOTOS_MAX_GALERIE = 800;
/* Au-dela, un fichier n'est pas un apercu : on refuse plutot que de
   stocker par erreur une photo en pleine qualite. */
export const POIDS_MAX_VIGNETTE = 90 * 1024;
export const POIDS_MAX_APERCU   = 450 * 1024;
export const IMAGES_PAR_ENVOI   = 10;

const RE_JETON = /^[A-Z0-9]{16}$/;
const RE_PHOTO = /^p\d{3,4}$/;
export const jetonValide = (t) => RE_JETON.test(String(t || ""));
export const idPhotoValide = (id) => RE_PHOTO.test(String(id || ""));
export const normaliserJeton = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

const propre = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

/* Le lien "tout telecharger", colle a la main par Matt. Seulement du https :
   il est affiche a la cliente, qui clique dessus. */
export function lienValide(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 500) return "";
  try { const u = new URL(s); return u.protocol === "https:" ? u.toString() : ""; }
  catch (e) { return ""; }
}

/* Le numero de la photo, tel que Matt le retrouvera dans Lightroom :
   le nom du fichier sans son extension. */
export function nomDePhoto(fichier) {
  return propre(String(fichier || "").replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,5}$/i, ""), 60) || "photo";
}

const idDe = (i) => "p" + String(i + 1).padStart(3, "0");

export function estExpiree(g, now = Date.now()) {
  return !!(g && g.expiresAt && now > g.expiresAt);
}

/* ---------- creation ---------- */
export async function creerGalerie(store, { clientId, prenom, nom, email, formule, seance,
                                             transfert, photos, now = Date.now() }) {
  if (!(formule in QUOTA)) return { erreur: "formule" };
  const liste = Array.isArray(photos) ? photos.slice(0, PHOTOS_MAX_GALERIE) : [];
  if (!liste.length) return { erreur: "photos" };

  let jeton = "";
  for (let i = 0; i < 8; i++) {
    const essai = makeCode(16);
    const deja = await store.get("g-" + essai, { type: "json" }).catch(() => null);
    if (!deja) { jeton = essai; break; }
  }
  if (!jeton) return { erreur: "jeton" };

  const exp = new Date(now);
  exp.setMonth(exp.getMonth() + DUREE_MOIS);
  const g = {
    jeton, clientId: propre(clientId, 40),
    prenom: propre(prenom, 40), nom: propre(nom, 80), email: propre(email, 120),
    formule, quota: QUOTA[formule], seance: propre(seance, 20) || "",
    transfert: lienValide(transfert), retouches: "",
    photos: liste.map((p, i) => ({ id: idDe(i), nom: nomDePhoto(p && p.nom) })),
    recues: [],          // les photos dont la vignette ET l'apercu sont arrives
    statut: "preparation",
    coeurs: [], selection: null,
    createdAt: now, expiresAt: exp.getTime(), vueAt: 0, envoyeeAt: 0,
  };
  await store.setJSON("g-" + jeton, g);
  await ajouterIndex(store, g);
  return { galerie: g };
}

/* ---------- l'index, pour la liste du CRM ---------- */
async function ajouterIndex(store, g) {
  try {
    const idx = (await store.get("galeries", { type: "json" })) || [];
    idx.unshift(ligneIndex(g));
    await store.setJSON("galeries", idx.slice(0, 500));
  } catch (e) {}
}
export function ligneIndex(g) {
  return {
    jeton: g.jeton, clientId: g.clientId, nom: [g.prenom, g.nom].filter(Boolean).join(" "),
    formule: g.formule, statut: g.statut, nbPhotos: g.photos.length,
    nbCoeurs: (g.selection ? g.selection.coeurs.length : (g.coeurs || []).length),
    createdAt: g.createdAt, expiresAt: g.expiresAt, vueAt: g.vueAt || 0,
  };
}
export async function majIndex(store, g) {
  try {
    const idx = (await store.get("galeries", { type: "json" })) || [];
    const i = idx.findIndex(x => x.jeton === g.jeton);
    if (i >= 0) idx[i] = ligneIndex(g); else idx.unshift(ligneIndex(g));
    await store.setJSON("galeries", idx);
  } catch (e) {}
}

export async function lireGalerie(store, jeton) {
  if (!jetonValide(jeton)) return null;
  try { return await store.get("g-" + jeton, { type: "json" }); } catch (e) { return null; }
}
export async function enregistrer(store, g) {
  await store.setJSON("g-" + g.jeton, g);
  await majIndex(store, g);
}

/* ---------- le format des photos ----------
   La galerie compose ses rangees avec le format de chaque photo (p.r =
   largeur / hauteur), que le CRM envoie depuis le 20/10/2026. Une galerie
   preparee avant ne l'a pas : a sa premiere ouverture, on le lit une fois
   dans l'en-tete de chaque miniature (le marqueur SOF du JPEG, sans rien
   decoder), et on le garde. Sans ca, les rangees bougeraient au fil du
   defilement, a mesure que les miniatures arrivent. */
export function formatJpeg(buf) {
  const b = new Uint8Array(buf);
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) return null;
    const m = b[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
      return w && h ? Math.round(w / h * 1000) / 1000 : null;
    }
    if (m === 0xDA || len < 2) return null;
    i += 2 + len;
  }
  return null;
}
export async function completerFormats(store, g) {
  const manquent = g.photos.filter(p => !(p.r > 0) && (g.recues || []).includes(p.id));
  if (!manquent.length) return false;
  for (let i = 0; i < manquent.length; i += 25) {
    await Promise.all(manquent.slice(i, i + 25).map(async p => {
      let r = null;
      try { const buf = await store.get("t-" + g.jeton + "-" + p.id, { type: "arrayBuffer" }); if (buf) r = formatJpeg(buf); } catch (e) {}
      /* Illisible : un format par defaut, pour ne pas relire a chaque visite. */
      p.r = (r > 0.2 && r < 5) ? r : 1.5;
    }));
  }
  return true;
}

/* ---------- ce que la cliente voit ----------
   Ni l'email, ni la fiche du CRM : un lien de galerie se transfere a la
   famille, et se lit par-dessus une epaule. */
export function vuePublique(g) {
  const s = g.selection;
  return {
    jeton: g.jeton, prenom: g.prenom, formule: g.formule, nomFormule: NOM_FORMULE[g.formule] || "",
    quota: g.quota, seance: g.seance,
    transfert: g.transfert, retouches: g.retouches,
    photos: g.photos.filter(p => (g.recues || []).includes(p.id)),
    coeurs: g.coeurs || [],
    selection: s ? {
      coeurs: s.coeurs, tirages: s.tirages || {}, at: s.at,
      enAttente: !!s.enAttente, paye: !!s.paye, montant: s.montant || 0,
    } : null,
    statut: g.statut, expiresAt: g.expiresAt,
  };
}

/* ---------- la selection, mise en forme ----------
   Les tirages arrivent photo par photo ({ p004: { "30x45": 2 } }) ; le
   panier du comptoir les veut taille par taille, avec les numeros. On garde
   les deux : le detail pour le CRM, les totaux pour le prix. */
export function tiragesParTaille(g, tirages, tailles) {
  const nom = Object.fromEntries(g.photos.map(p => [p.id, p.nom]));
  const totaux = {}, numeros = {}, detail = [];
  const cles = tailles.map(t => t.cle);
  for (const [id, q] of Object.entries(tirages || {})) {
    if (!nom[id] || !q || typeof q !== "object") continue;
    for (const cle of cles) {
      const n = Math.max(0, Math.min(parseInt(q[cle], 10) || 0, 30));
      if (!n) continue;
      totaux[cle] = (totaux[cle] || 0) + n;
      (numeros[cle] = numeros[cle] || []).push(nom[id] + (n > 1 ? " (x" + n + ")" : ""));
      detail.push({ id, nom: nom[id], cle, n });
    }
  }
  const numerosTexte = Object.fromEntries(Object.entries(numeros).map(([k, v]) => [k, v.join(", ")]));
  return { totaux, numeros: numerosTexte, detail };
}

/* ---------- les envois a d'autres personnes ----------
   "Envoyer des tirages a d'autres personnes" : sa mere, ses beaux-parents.
   Chaque envoi a son adresse et ses tirages, photo par photo. Les PRIX
   (tirages, et frais d'envoi par adresse) sont dans mbs-panier.mjs,
   lignesAutresEnvois. Ici on ne fait que nettoyer et verifier. */
export const ENVOIS_MAX = 5;
export function autresEnvois(g, envois, tailles) {
  const out = [], erreurs = [];
  const nomTaille = Object.fromEntries(tailles.map(t => [t.cle, t.nom]));
  (Array.isArray(envois) ? envois.slice(0, ENVOIS_MAX) : []).forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const a = (e.adresse && typeof e.adresse === "object") ? e.adresse : {};
    const adresse = { nom: propre(a.nom, 80), ligne1: propre(a.ligne1, 120), ligne2: propre(a.ligne2, 120),
                      cp: propre(a.cp, 12), ville: propre(a.ville, 80) };
    const t = tiragesParTaille(g, e.tirages, tailles);
    const nb = t.detail.reduce((s, x) => s + x.n, 0);
    /* Un bloc ouvert puis laisse vide : on l'ignore sans rien dire. */
    if (!nb && !Object.values(adresse).some(Boolean)) return;
    const qui = adresse.nom || "la personne n° " + (i + 1);
    if (!nb) { erreurs.push("Ajoutez au moins un tirage pour " + qui + ", ou retirez cette adresse."); return; }
    if (!adresse.nom || !adresse.ligne1 || !adresse.cp || !adresse.ville) {
      erreurs.push("Indiquez l'adresse complète pour " + qui + " : nom, adresse, code postal et ville."); return;
    }
    const tirages = {};
    t.detail.forEach(x => { (tirages[x.id] = tirages[x.id] || {})[x.cle] = x.n; });
    out.push({
      adresse, tirages, totaux: t.totaux, numeros: t.numeros, nb,
      adresseTexte: [adresse.nom, adresse.ligne1, adresse.ligne2, [adresse.cp, adresse.ville].join(" ")]
        .filter(Boolean).join("\n"),
      tiragesTexte: Object.entries(t.numeros).map(([cle, n]) => (nomTaille[cle] || cle) + " : " + n).join("\n"),
    });
  });
  return { envois: out, erreurs };
}

/* Les coeurs gardes : seulement des photos de cette galerie, sans doublon. */
export function coeursPropres(g, coeurs) {
  const ids = new Set(g.photos.map(p => p.id));
  return [...new Set((Array.isArray(coeurs) ? coeurs : []).map(String))].filter(id => ids.has(id));
}

/* Ce qui depasse la formule. Prestige : rien ne depasse. */
export function photosEnPlus(g, nbCoeurs) {
  return g.quota ? Math.max(0, nbCoeurs - g.quota) : 0;
}

/* ---------- suppression ---------- */
/* Par paquets de 25 en parallele : une galerie de 400 photos, c'est 800
   images a effacer, et le menage planifie n'a que quelques dizaines de
   secondes. L'une apres l'autre, une seule galerie aurait pu ne pas finir. */
export async function supprimerGalerie(store, g) {
  const cles = [];
  for (const p of g.photos) cles.push("t-" + g.jeton + "-" + p.id, "v-" + g.jeton + "-" + p.id);
  for (let i = 0; i < cles.length; i += 25) {
    await Promise.all(cles.slice(i, i + 25).map(k => store.delete(k).catch(() => {})));
  }
  try { await store.delete("g-" + g.jeton); } catch (e) {}
  try {
    const idx = (await store.get("galeries", { type: "json" })) || [];
    await store.setJSON("galeries", idx.filter(x => x.jeton !== g.jeton));
  } catch (e) {}
}

/* Le texte de la selection, pour la tache du CRM et la notification.
   photosSeules : le rappel d'une commande payee donne deja les tirages et
   l'adresse (lignes du lien de paiement) ; on ne les repete pas. */
export function texteSelection(g, { photosSeules = false } = {}) {
  const s = g.selection; if (!s) return "";
  const nom = Object.fromEntries(g.photos.map(p => [p.id, p.nom]));
  const lignes = [];
  lignes.push(s.coeurs.length + " photo" + (s.coeurs.length > 1 ? "s" : "") + " choisie"
    + (s.coeurs.length > 1 ? "s" : "") + (g.quota ? " (" + g.quota + " comprises dans la formule "
    + NOM_FORMULE[g.formule] + ")" : " (formule Prestige)") + " :");
  if (s.coeurs.length) lignes.push(s.coeurs.map(id => nom[id] || id).join(", "));
  if (!photosSeules) {
    if (s.tiragesTexte) lignes.push("", "Tirages :", s.tiragesTexte);
    if (s.adresseTexte) lignes.push("", "À poster à :", s.adresseTexte);
  }
  /* Les autres adresses ne figurent nulle part ailleurs : le paiement ne
     garde que celle de la cliente. Elles sont donc toujours ici. */
  (s.envois || []).forEach(e => {
    lignes.push("", "AUSSI À POSTER À :", e.adresseTexte, "Tirages pour cette adresse :", e.tiragesTexte);
  });
  return lignes.join("\n");
}
