// netlify/mbs-liens.mjs
// Les liens de paiement : ce qu'une cliente peut encore regler apres sa
// seance, envoye par SMS ou par mail.
//
// DEUX CHOSES SUR UNE MEME PAGE
// 1. Les montees en gamme : passer en Confort, en Prestige... On n'en prend
//    qu'UNE, forcement : on ne passe pas a la fois en Confort et en
//    Prestige. Elles se presentent cote a cote, parce qu'une proposition
//    seule s'arbitre contre "non" tandis que deux s'arbitrent l'une contre
//    l'autre.
// 2. Les complements, qui s'ajoutent librement et se cumulent : photos
//    retouchees en plus, album, tirages papier. Chacun avec sa quantite.
//    Leurs prix vivent dans mbs-panier.mjs, et nulle part ailleurs.
//
// POURQUOI UN CODE ET PAS UNE SESSION STRIPE
// Une session Stripe expire au bout de 24 heures, c'est une limite de
// Stripe. Un lien envoye par SMS un vendredi soir serait mort le samedi.
// On stocke donc un code, et la page du site cree la session au moment
// ou la cliente clique. Le lien ne perime jamais.
//
// LES MONTANTS NE VIENNENT JAMAIS DU NAVIGATEUR
// La page n'envoie que des IDENTIFIANTS et des QUANTITES. Le total est
// refait ici a chaque fois. Une adresse trafiquee, ou une requete forgee,
// ne peuvent donc pas changer un prix.
import { getStore } from "@netlify/blobs";
import { makeCode } from "./mbs-coupons.mjs";
import { calculerPanier, grillePublique } from "./mbs-panier.mjs";

export const LIEN_STORE = "mbs-liens";

/* Garde-fous sur le montant. Le plancher evite les liens a 1 euro crees
   par erreur, le plafond attrape la faute de frappe qui ajoute un zero. */
export const LIEN_MIN = 10;
export const LIEN_MAX = 3000;

/* Au-dessus de ce montant, le paiement en 3 fois est propose. En dessous,
   il n'a pas de sens : etaler 60 euros sur trois mois est plus penible
   qu'utile. Il se decide sur le TOTAL du panier. */
export const LIEN_SEUIL_3X = 150;

/* Nombre de montees en gamme proposables. C'etait 3 : Matt en voulait
   davantage, pour pouvoir tout mettre sur la table. Au-dela de huit, ce
   n'est plus une page, c'est un catalogue. */
export const LIEN_OPTIONS_MAX = 8;

export function lienStore() {
  return getStore({ name: LIEN_STORE, consistency: "strong" });
}

export function normaliserCode(brut) {
  return String(brut || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function montantValide(v) {
  const n = Math.round(Number(String(v).replace(",", ".")));
  if (!Number.isFinite(n) || n < LIEN_MIN || n > LIEN_MAX) return null;
  return n;
}

/* Six lignes suffisent a dire ce qu'on gagne. Au-dela, la page devient un
   catalogue et l'argument se noie. */
function nettoyerGains(gains) {
  return (Array.isArray(gains) ? gains : [])
    .map(g => String(g || "").trim().slice(0, 120)).filter(Boolean).slice(0, 6);
}

/* Ce que Matt accepte de proposer en plus sur ce lien. Ce qui n'est pas
   ici n'existe pas : demander un album sur un lien qui n'en propose pas
   ne cree aucune ligne, meme en forgeant la requete. */
export function normaliserExtras(brut) {
  const e = (brut && typeof brut === "object") ? brut : {};
  return { photos: !!e.photos, album: !!e.album, tirages: !!e.tirages };
}
export const aDesExtras = (e) => !!(e && (e.photos || e.album || e.tirages));

/* Met en forme les montees en gamme. Tout ce qui est douteux est ecarte
   plutot que corrige : mieux vaut une marche en moins qu'une marche a un
   prix invente. */
export function normaliserOptions(brut, secours = {}) {
  const src = Array.isArray(brut) ? brut : [];
  const out = [];
  src.forEach((o, i) => {
    if (out.length >= LIEN_OPTIONS_MAX) return;
    const montant = montantValide(o && o.montant);
    const titre = String((o && o.titre) || "").trim().slice(0, 120);
    if (montant === null || !titre) return;
    out.push({
      id: "o" + (i + 1), titre, montant,
      gains: nettoyerGains(o && o.gains),
      conseil: !!(o && o.conseil),
    });
  });

  /* Un lien sans marche declaree reste un lien a montant unique : c'est la
     forme des liens crees avant, et celle du "autre montant". */
  if (!out.length && montantValide(secours.montant) !== null) {
    out.push({
      id: "o1", titre: String(secours.libelle || "Complément").slice(0, 120),
      montant: montantValide(secours.montant), gains: nettoyerGains(secours.gains),
      conseil: false,
    });
  }

  /* Du moins cher au plus cher : la cliente doit lire une montee, pas une
     liste. L'ecart avec la marche precedente n'a de sens que dans cet ordre. */
  out.sort((a, b) => a.montant - b.montant);

  /* Un seul conseil, sinon ce n'est plus un conseil. */
  let vu = false;
  out.forEach(o => { if (o.conseil && !vu) vu = true; else o.conseil = false; });
  return out;
}

/* Les marches d'un lien, quelle que soit sa forme. Les liens crees avant
   cette version n'ont pas de champ options : on leur en fabrique une a
   partir de leur montant, et toute la suite du code les traite pareil. */
export function optionsDe(lien) {
  if (!lien) return [];
  if (Array.isArray(lien.options) && lien.options.length) return lien.options;
  return normaliserOptions([], { montant: lien.montant, libelle: lien.libelle, gains: lien.gains });
}

export function extrasDe(lien) {
  return normaliserExtras(lien && lien.extras);
}

/* Le panier d'une cliente, recalcule a partir de ce que porte le lien et
   des seules quantites recues. Point de passage unique : la page, la
   creation de la session Stripe et la facture s'appuient tous dessus. */
export function panierDuLien(lien, choix) {
  return calculerPanier({
    formules: optionsDe(lien),
    extras: extrasDe(lien),
    choix: choix || {},
  });
}

/* La marche designee par le navigateur. Si le lien n'en porte qu'une et
   n'offre rien d'autre, on l'accepte sans identifiant : la page d'un
   montant unique n'en envoie pas. */
export function optionChoisie(lien, id) {
  const opts = optionsDe(lien);
  const cle = String(id || "").trim();
  const trouvee = opts.find(o => o.id === cle);
  if (trouvee) return trouvee;
  return (opts.length === 1 && !aDesExtras(extrasDe(lien))) ? opts[0] : null;
}

/* Ce qui doit apparaitre sur la facture et dans le CRM. On repart des
   options plutot que de la metadonnee Stripe : le titre stocke ici est le
   seul que Matt a relu. */
export function titreChoisi(lien, md) {
  const o = optionChoisie(lien, md && md.optionId);
  return (o && o.titre) || (md && md.libelle) || (lien && lien.libelle) || "Complément";
}

/* Ce que la page publique a le droit de savoir. Surtout pas l'email ni le
   nom de famille : le lien peut etre transfere, ou lu par-dessus l'epaule. */
export function vuePublique(l) {
  const options = optionsDe(l);
  const extras = extrasDe(l);
  const premiere = options[0] || null;
  return {
    code: l.code,
    prenom: l.prenom || "",
    statut: l.statut,
    /* Le texte qui explique ce qu'elle gagne. C'est lui qui fait la
       difference entre "reglez 100 euros" et une proposition qu'on
       comprend. Matt l'ecrit et peut le modifier a chaque fois. */
    argument: l.argument || "",
    options: options.map(o => ({
      id: o.id, titre: o.titre, montant: o.montant,
      gains: Array.isArray(o.gains) ? o.gains : [],
      conseil: !!o.conseil,
      troisFois: o.montant >= LIEN_SEUIL_3X,
    })),
    extras,
    /* La grille sert a AFFICHER un total pendant qu'elle coche. Le prix
       reellement facture est refait par le serveur au moment du clic. */
    grille: aDesExtras(extras) ? grillePublique() : null,
    seuil3x: LIEN_SEUIL_3X,
    /* Champs de l'ancienne page, gardes tant qu'une page en cache peut
       encore les lire : elle affichera la premiere marche seule plutot que
       de tomber sur du vide. */
    libelle: premiere ? premiere.titre : (l.libelle || "Complément"),
    montant: premiere ? premiere.montant : l.montant,
    gains: premiere ? premiere.gains : [],
    troisFois: premiere ? premiere.montant >= LIEN_SEUIL_3X : false,
  };
}

export async function creerLien(store, { clientId, prenom, nom, email, montant, libelle,
                                         argument = "", gains = [], options = [], extras = {},
                                         now = Date.now() }) {
  const marches = normaliserOptions(options, { montant, libelle, gains });
  const sup = normaliserExtras(extras);
  /* Un lien doit proposer quelque chose : une marche, ou de quoi remplir
     un panier. */
  if (!marches.length && !aDesExtras(sup)) return null;

  let code = "";
  for (let i = 0; i < 8; i++) {
    const essai = makeCode(8);
    const deja = await store.get("l-" + essai, { type: "json" }).catch(() => null);
    if (!deja) { code = essai; break; }
  }
  if (!code) return null;

  const lien = {
    code, clientId: String(clientId || ""),
    prenom: String(prenom || "").slice(0, 40),
    nom: String(nom || "").slice(0, 80),
    email: String(email || "").slice(0, 120),
    options: marches, extras: sup,
    /* Le montant du lien est celui de sa marche la moins chere : c'est ce
       qu'il faut afficher dans la liste du CRM tant que rien n'est paye.
       Zero quand le lien n'offre que des complements, dont le total depend
       de ce qu'elle choisira. Une fois paye, les deux sont remplaces par
       ce qu'elle a vraiment pris. */
    montant: marches.length ? marches[0].montant : 0,
    libelle: marches.length ? marches[0].titre : "À la carte",
    argument: String(argument || "").trim().slice(0, 1400),
    gains: marches.length ? marches[0].gains : [],
    statut: "attente",
    choix: null, paniers: {},
    createdAt: now, paidAt: 0, sessionId: "", invoiceNumber: "",
  };
  await store.setJSON("l-" + code, lien);

  try {
    const idx = (await store.get("liens", { type: "json" })) || [];
    idx.unshift({ code, clientId: lien.clientId, nom: lien.nom, montant: lien.montant,
                  libelle: lien.libelle, options: marches.length, extras: aDesExtras(sup),
                  statut: "attente", createdAt: now });
    await store.setJSON("liens", idx.slice(0, 300));
  } catch (e) {}

  return lien;
}

/* Ce qu'elle a coche, garde le temps d'aller chez Stripe et d'en revenir.
   On l'attache a la session : si elle ouvre le paiement deux fois avec
   deux paniers differents, c'est bien celui qu'elle a regle qui sera
   facture. On n'en garde que quelques-uns, le temps de la manoeuvre. */
export async function memoriserPanier(store, lien, sessionId, panier) {
  try {
    const p = (lien.paniers && typeof lien.paniers === "object") ? lien.paniers : {};
    p[sessionId] = { lignes: panier.lignes, total: panier.total, adresse: panier.adresse || null, t: Date.now() };
    const cles = Object.keys(p).sort((a, b) => (p[b].t || 0) - (p[a].t || 0)).slice(0, 6);
    lien.paniers = {};
    cles.forEach(k => { lien.paniers[k] = p[k]; });
    await store.setJSON("l-" + lien.code, lien);
  } catch (e) {}
}

export function panierDeSession(lien, sessionId) {
  const p = (lien && lien.paniers && typeof lien.paniers === "object") ? lien.paniers : {};
  return p[sessionId] || null;
}

/* L'index sert la liste du CRM. Sans cette mise a jour, un lien paye
   continuerait d'y apparaitre comme en attente. */
export async function majIndex(store, code, champs) {
  try {
    const idx = (await store.get("liens", { type: "json" })) || [];
    const e = idx.find(x => x.code === code);
    if (e) { Object.assign(e, champs); await store.setJSON("liens", idx); }
  } catch (e) {}
}
