// netlify/mbs-liens.mjs
// Les liens de paiement : ce qu'une cliente peut encore regler apres sa
// seance, envoye par SMS ou par mail.
//
// A QUOI CA SERT
// Une cliente arrive avec un bon cadeau pour la formule a 290 euros. Elle
// voit ses photos. Il lui manque 100 euros pour passer a la formule du
// dessus. Plutot que de lui demander un virement, Matt lui envoie un lien.
//
// POURQUOI PLUSIEURS MARCHES SUR UN MEME LIEN
// Une seule proposition ne se compare a rien : la cliente arbitre entre
// "oui" et "non". Quand elle voit la marche suivante a cote, elle arbitre
// entre "celle-ci" et "celle-la", et le non sort de l'ecran. C'est le
// raisonnement de Matt : a 100 euros elle passe en Confort, mais pour 100
// de plus elle a la Prestige, ou tout est trie et retouche.
// Trois marches au maximum. Au-dela ce n'est plus une montee en gamme,
// c'est un catalogue, et un catalogue ne se choisit pas.
//
// POURQUOI UN CODE ET PAS UNE SESSION STRIPE
// Une session Stripe expire au bout de 24 heures, c'est une limite de
// Stripe. Un lien envoye par SMS un vendredi soir serait mort le samedi.
// On stocke donc un code, et la page du site cree la session au moment
// ou la cliente clique. Le lien ne perime jamais.
//
// LES MONTANTS NE VIENNENT JAMAIS DU NAVIGATEUR
// Ils sont lus ici, dans le stockage, a chaque fois. La page n'envoie que
// l'IDENTIFIANT de la marche choisie. Une adresse trafiquee, ou une
// requete forgee, ne peuvent donc pas changer le prix.
import { getStore } from "@netlify/blobs";
import { makeCode } from "./mbs-coupons.mjs";

export const LIEN_STORE = "mbs-liens";

/* Garde-fous sur le montant. Le plancher evite les liens a 1 euro crees
   par erreur, le plafond attrape la faute de frappe qui ajoute un zero. */
export const LIEN_MIN = 10;
export const LIEN_MAX = 3000;

/* Au-dessus de ce montant, le paiement en 3 fois est propose. En dessous,
   il n'a pas de sens : etaler 60 euros sur trois mois est plus penible
   qu'utile. Il se decide marche par marche, pas une fois pour le lien :
   sur une page a deux choix, l'un peut y avoir droit et l'autre non. */
export const LIEN_SEUIL_3X = 150;

/* Trois marches au maximum sur une meme page. Voir l'en-tete. */
export const LIEN_OPTIONS_MAX = 3;

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

/* Met en forme les marches proposees. Tout ce qui est douteux est ecarte
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

/* La marche designee par le navigateur. Si le lien n'en porte qu'une, on
   l'accepte sans identifiant : la page d'un montant unique n'en envoie pas. */
export function optionChoisie(lien, id) {
  const opts = optionsDe(lien);
  const cle = String(id || "").trim();
  const trouvee = opts.find(o => o.id === cle);
  if (trouvee) return trouvee;
  return opts.length === 1 ? opts[0] : null;
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
                                         argument = "", gains = [], options = [],
                                         now = Date.now() }) {
  const marches = normaliserOptions(options, { montant, libelle, gains });
  if (!marches.length) return null;

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
    options: marches,
    /* Le montant du lien est celui de sa marche la moins chere : c'est ce
       qu'il faut afficher dans la liste du CRM tant que rien n'est paye.
       Une fois regle, ils sont remplaces par ce qu'elle a vraiment choisi. */
    montant: marches[0].montant,
    libelle: marches[0].titre,
    argument: String(argument || "").trim().slice(0, 1400),
    gains: marches[0].gains,
    statut: "attente",
    choix: null,
    createdAt: now, paidAt: 0, sessionId: "", invoiceNumber: "",
  };
  await store.setJSON("l-" + code, lien);

  try {
    const idx = (await store.get("liens", { type: "json" })) || [];
    idx.unshift({ code, clientId: lien.clientId, nom: lien.nom, montant: lien.montant,
                  libelle: lien.libelle, options: marches.length,
                  statut: "attente", createdAt: now });
    await store.setJSON("liens", idx.slice(0, 300));
  } catch (e) {}

  return lien;
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
