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

/* LA GALERIE A DEUX SEANCES (23/10/2026). Une cliente qui vient pour sa
   grossesse puis pour la naissance a UNE galerie, et UN total de retouches
   a repartir entre les deux comme elle veut. Formule "duo", une formule par
   seance dans g.formules. Deux facons de choisir, voulues par Matt :
     - tout d'un coup, quand les deux seances sont en ligne ;
     - en deux fois : elle valide ses photos de grossesse, et quand Matt
       ajoute la naissance (action "ajouter-seance"), elle choisit avec ce
       qui lui reste. Le premier choix est alors range dans g.passees, avec
       ses retouches. */
export const SEANCES_DUO = ["grossesse", "naissance"];
export const NOM_SEANCE = { grossesse: "Grossesse", naissance: "Naissance", bebe: "Bébé" };
/* Le total de retouches se regle a la main (Matt offre des photos) :
   au-dela, c'est une faute de frappe. */
export const QUOTA_MAX = 300;
export function quotaSaisi(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= QUOTA_MAX ? n : NaN;
}
/* Ce que comprennent les formules, sans geste de Matt. Une seance Prestige
   (retouches sans limite) rend le total sans limite : Matt peut toujours
   fixer un nombre. */
export function quotaDesFormules(formule, formules) {
  if (formule !== "duo") return QUOTA[formule] || 0;
  const a = QUOTA[formules.grossesse], b = QUOTA[formules.naissance];
  return (!a || !b) ? 0 : a + b;
}
export function nomFormuleDe(g) {
  if (g.formule === "duo" && g.formules) {
    const a = NOM_FORMULE[g.formules.grossesse] || "", b = NOM_FORMULE[g.formules.naissance] || "";
    return a === b ? a + " (grossesse et naissance)" : "Grossesse " + a + ", naissance " + b;
  }
  return NOM_FORMULE[g.formule] || "";
}
/* Les retouches comprises deja prises par les choix precedents, et ce qui
   reste pour le choix en cours. Sans limite (quota 0) : rien ne s'use. */
export const comprisesDe = (g, t) => t.comprises != null ? t.comprises
  : (g.quota ? Math.min((t.coeurs || []).length, g.quota) : 0);
export function quotaRestant(g) {
  if (!g.quota) return 0;
  return Math.max(0, g.quota - (g.passees || []).reduce((a, t) => a + comprisesDe(g, t), 0));
}
/* Les photos deja choisies (et retouchees, ou en cours) : on ne les
   rechoisit pas. */
export const dejaChoisies = (g) => new Set((g.passees || []).flatMap(t => t.coeurs || []));
/* Les seances d'une liste de photos, dans l'ordre grossesse puis naissance. */
export function seancesDe(g, ids) {
  const s = new Set(g.photos.filter(p => ids.includes(p.id)).map(p => p.s).filter(Boolean));
  return SEANCES_DUO.filter(k => s.has(k));
}

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

/* ---------- creation ----------
   Galerie a deux seances : formule "duo", formules {grossesse, naissance},
   et chaque photo dit sa seance (photos[i].seance). Une seule seance peut
   suffire a la creation : l'autre s'ajoute plus tard (ajouterSeance).
   quota : le total de retouches comprises, s'il differe des formules. */
export async function creerGalerie(store, { clientId, prenom, nom, email, formule, formules, quota, seance,
                                             transfert, transferts, photos, now = Date.now() }) {
  const duo = formule === "duo";
  let fs = null;
  if (duo) {
    fs = { grossesse: String((formules && formules.grossesse) || ""), naissance: String((formules && formules.naissance) || "") };
    if (!(fs.grossesse in QUOTA) || !(fs.naissance in QUOTA)) return { erreur: "formule" };
  } else if (!(formule in QUOTA)) return { erreur: "formule" };
  const saisi = quotaSaisi(quota);
  if (Number.isNaN(saisi)) return { erreur: "quota" };
  const base = quotaDesFormules(formule, fs);
  const liste = Array.isArray(photos) ? photos.slice(0, PHOTOS_MAX_GALERIE) : [];
  if (!liste.length) return { erreur: "photos" };
  /* En duo, chaque photo appartient a une seance, et on les range grossesse
     d'abord : la galerie les presente dans cet ordre. */
  if (duo) {
    if (liste.some(p => !SEANCES_DUO.includes(String((p && p.seance) || "")))) return { erreur: "seance" };
    liste.sort((a, b) => SEANCES_DUO.indexOf(a.seance) - SEANCES_DUO.indexOf(b.seance));
  }

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
    formule, quota: saisi == null ? base : saisi, quotaFormule: base,
    seance: duo ? "duo" : (propre(seance, 20) || ""),
    transfert: duo ? "" : lienValide(transfert), retouches: "",
    photos: liste.map((p, i) => duo ? { id: idDe(i), nom: nomDePhoto(p && p.nom), s: p.seance }
                                    : { id: idDe(i), nom: nomDePhoto(p && p.nom) }),
    recues: [],          // les photos dont la vignette ET l'apercu sont arrives
    statut: "preparation",
    coeurs: [], selection: null,
    createdAt: now, expiresAt: exp.getTime(), vueAt: 0, envoyeeAt: 0,
  };
  if (duo) {
    g.formules = fs;
    /* Les seances deja la. "prete" : visible de la cliente (a la
       publication). Le lien "tout telecharger" est propre a chaque seance :
       deux SwissTransfer, a des mois d'ecart. */
    const presentes = new Set(liste.map(p => p.seance));
    const liens = (transferts && typeof transferts === "object") ? transferts : {};
    g.seances = SEANCES_DUO.filter(k => presentes.has(k))
      .map(cle => ({ cle, transfert: lienValide(liens[cle]), prete: false, at: 0 }));
    g.passees = [];
  }
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
/* Les tirages d'une commande : les siens et ceux envoyes a d'autres. */
const tiragesDe = (s) => Object.values(s.tirages || {}).reduce((a, q) =>
    a + Object.values(q || {}).reduce((b, n) => b + (parseInt(n, 10) || 0), 0), 0)
  + (s.envois || []).reduce((a, e) => a + (e.nb || 0), 0);
/* Les choix arrives chez Matt et pas encore retouches : le choix en cours
   s'il est valide (et paye), et, dans une galerie a deux seances, un choix
   precedent que Matt n'a pas encore livre. */
export function choixARetoucher(g) {
  const s = g.selection, out = [];
  (g.passees || []).forEach((t, i) => { if (!t.retouches) out.push({ tour: i, t }); });
  if (s && !s.enAttente && !g.retouches) out.push({ tour: "", t: s });
  return out;
}
export function ligneIndex(g) {
  const s = g.selection;
  const aFaire = choixARetoucher(g);
  return {
    jeton: g.jeton, clientId: g.clientId, nom: [g.prenom, g.nom].filter(Boolean).join(" "),
    formule: g.formule, statut: g.statut, nbPhotos: g.photos.length,
    nbCoeurs: (s ? s.coeurs.length : (g.coeurs || []).length),
    createdAt: g.createdAt, expiresAt: g.expiresAt, vueAt: g.vueAt || 0,
    /* L'onglet "A retoucher" du CRM : depuis quand la selection est arrivee
       chez Matt (payee s'il y avait a payer), et ce qu'il a a faire. Avec
       deux choix en attente, le plus ancien donne la date. */
    aRetoucher: aFaire.length > 0,
    choisieAt: aFaire.length ? Math.min(...aFaire.map(x => x.t.payeAt || x.t.at || 0)) : 0,
    nbARetoucher: aFaire.reduce((a, x) => a + (x.t.coeurs || []).length, 0),
    enPlus: aFaire.reduce((a, x) => a + (x.t.enPlus || 0), 0), quota: g.quota || 0,
    nbTirages: aFaire.reduce((a, x) => a + tiragesDe(x.t), 0),
    retouchesAt: g.retouchesAt || 0,
    /* Galerie a deux seances : celles deja en ligne. */
    seances: g.seances ? g.seances.map(x => x.cle) : null,
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
  /* Une seance ajoutee apres coup reste cachee tant que Matt n'a pas fini
     d'en deposer les photos. */
  const cachees = new Set((g.seances || []).filter(x => !x.prete).map(x => x.cle));
  const recues = new Set(g.recues || []);
  /* Les photos offertes par Matt : ce qui depasse les formules. */
  const offertes = (g.quota && g.quotaFormule > 0) ? Math.max(0, g.quota - g.quotaFormule) : 0;
  return {
    jeton: g.jeton, prenom: g.prenom, formule: g.formule, nomFormule: nomFormuleDe(g),
    quota: g.quota, quotaRestant: quotaRestant(g), offertes, seance: g.seance,
    transfert: g.transfert, retouches: g.retouches,
    photos: g.photos.filter(p => recues.has(p.id) && !(p.s && cachees.has(p.s))),
    coeurs: g.coeurs || [],
    selection: s ? {
      coeurs: s.coeurs, tirages: s.tirages || {}, at: s.at,
      enAttente: !!s.enAttente, paye: !!s.paye, montant: s.montant || 0,
    } : null,
    /* Galerie a deux seances : les seances en ligne (et leur lien de
       telechargement), et les choix deja faits, avec leurs retouches. */
    duo: g.formule === "duo",
    seances: g.seances ? g.seances.filter(x => x.prete).map(x => ({ cle: x.cle, transfert: x.transfert || "", at: x.at || 0 })) : null,
    passees: (g.passees || []).map(t => ({ coeurs: t.coeurs || [], at: t.at, seances: t.seances || [],
                                           retouches: t.retouches || "" })),
    statut: g.statut, expiresAt: g.expiresAt, couverture: g.couverture || "",
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

/* Les coeurs gardes : seulement des photos de cette galerie, sans doublon,
   ni une photo deja choisie la fois d'avant (galerie a deux seances). */
export function coeursPropres(g, coeurs) {
  const ids = new Set(g.photos.map(p => p.id)), deja = dejaChoisies(g);
  return [...new Set((Array.isArray(coeurs) ? coeurs : []).map(String))].filter(id => ids.has(id) && !deja.has(id));
}

/* Ce qui depasse la formule, une fois retire ce que les choix precedents
   ont deja pris. Prestige : rien ne depasse. */
export function photosEnPlus(g, nbCoeurs) {
  return g.quota ? Math.max(0, nbCoeurs - quotaRestant(g)) : 0;
}

/* ---------- la seconde seance ----------
   Matt ajoute les photos de la naissance a la galerie de la grossesse.
   Elles restent cachees (prete: false) jusqu'a la publication. */
export function ajouterSeance(g, { seance, transfert, photos }) {
  if (g.formule !== "duo" || !g.seances) return { erreur: "pas_duo" };
  const cle = String(seance || "");
  if (!SEANCES_DUO.includes(cle)) return { erreur: "seance" };
  if (g.seances.some(x => x.cle === cle)) return { erreur: "deja" };
  const liste = Array.isArray(photos) ? photos : [];
  if (!liste.length) return { erreur: "photos" };
  if (g.photos.length + liste.length > PHOTOS_MAX_GALERIE) return { erreur: "trop" };
  const depart = g.photos.length;
  const nouvelles = liste.map((p, i) => ({ id: idDe(depart + i), nom: nomDePhoto(p && p.nom), s: cle }));
  g.photos.push(...nouvelles);
  g.seances.push({ cle, transfert: lienValide(transfert), prete: false, at: 0 });
  g.seances.sort((a, b) => SEANCES_DUO.indexOf(a.cle) - SEANCES_DUO.indexOf(b.cle));
  return { photos: nouvelles };
}
/* La seance ajoutee passe en ligne. Si la cliente avait deja valide son
   choix (et paye s'il le fallait), ce choix est range avec ses retouches :
   elle repart avec ce qui lui reste. Un choix en attente de paiement, lui,
   reste ouvert : elle peut encore le changer, naissance comprise. */
export function nouveauChoix(g) {
  const s = g.selection;
  if (!s || s.enAttente) return false;
  (g.passees = g.passees || []).push({ ...s, comprises: comprisesDe(g, s), seances: seancesDe(g, s.coeurs || []),
    retouches: g.retouches || "", retouchesAt: g.retouchesAt || 0 });
  g.selection = null; g.coeurs = []; g.retouches = ""; g.retouchesAt = 0;
  g.statut = "envoyee";
  return true;
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
  const n = s.coeurs.length, pl = n > 1 ? "s" : "";
  /* Ce qui est compris : sur ce qui restait, si un premier choix a deja
     pris sa part (galerie a deux seances). */
  const comprises = comprisesDe(g, s), avant = (g.passees || []).length;
  const detail = !g.quota ? "formule " + (nomFormuleDe(g) || "Prestige") + ", sans limite"
    : comprises + " comprise" + (comprises > 1 ? "s" : "") + (s.enPlus ? ", " + s.enPlus + " en plus" : "")
      + (avant ? " ; " + quotaRestant(g) + " restaient sur les " + g.quota : " ; " + g.quota + " au total")
      + ", formule " + nomFormuleDe(g);
  lignes.push(n + " photo" + pl + " choisie" + pl + " (" + detail + ") :");
  /* Les numeros, seance par seance : Matt retouche dans deux dossiers. */
  if (n && g.formule === "duo") {
    const parSeance = SEANCES_DUO.map(k => [k, s.coeurs.filter(id => (g.photos.find(p => p.id === id) || {}).s === k)]);
    parSeance.forEach(([k, ids]) => { if (ids.length) lignes.push(NOM_SEANCE[k] + " (" + ids.length + ") : " + ids.map(id => nom[id] || id).join(", ")); });
  } else if (n) lignes.push(s.coeurs.map(id => nom[id] || id).join(", "));
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
