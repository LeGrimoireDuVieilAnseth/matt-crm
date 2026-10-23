// netlify/mbs-panier.mjs
// Ce qu'une cliente peut ajouter apres sa seance, et ce que ca coute.
//
// C'EST ICI LA REFERENCE DES PRIX, ET NULLE PART AILLEURS.
// La page affiche un total, elle ne le decide pas : le serveur recalcule
// tout a partir des seules quantites. Une requete forgee ne peut donc pas
// changer un prix, seulement demander une quantite.
//
// A NE PAS CONFONDRE avec les tarifs de mbs-lib.mjs, qui servent a la
// RESERVATION sur le site. Une photo supplementaire y coute 15 euros tout
// simplement, sans palier : c'est le choix de Matt, le formulaire de
// reservation doit rester lisible d'un coup d'oeil. Les paliers ci-dessous
// n'existent que dans le lien envoye apres la seance.

/* Photos retouchees supplementaires (grille de Matt du 23/10/2026).
   1 a 4  : 15 euros piece.
   5 et + : 10 euros piece, TOUTES : 5 photos = 50 euros, 10 = 100.
   (Avant : une photo offerte de 5 a 9, et 10 euros seulement des 10.)

   Consequence a connaitre : 4 photos coutent 60 euros et 5 en coutent 50.
   Le prix baisse en montant d'une photo. C'est la grille voulue par Matt ;
   la page le dit a la cliente au lieu de le laisser passer pour un bug, et
   ca l'invite a en prendre cinq. Voir conseilPhotos().
   grillePublique garde les cles historiques photoDes10 et grosDes. */
export const PRIX_PHOTO = 15;
export const PRIX_PHOTO_DEGRESSIF = 10;
export const PHOTOS_DEGRESSIF_DES = 5;
export const PHOTOS_MAX = 60;

export const PRIX_ALBUM_PANIER = 150;
export const ALBUMS_MAX = 5;

/* Tirages papier. La cliente doit dire QUELLES photos elle veut tirer :
   sans les numeros, Matt ne peut rien imprimer. */
export const TAILLES = [
  { cle: "20x30", nom: "20 × 30 cm", prix: 10 },
  { cle: "30x45", nom: "30 × 45 cm", prix: 15 },
  { cle: "40x60", nom: "40 × 60 cm", prix: 20 },
];
export const TIRAGES_MAX = 30;

/* Envoi postal : 5 euros, offert des 50 euros de tirages. Ne s'applique
   qu'aux tirages : le reste est numerique et ne s'envoie pas. */
export const FRAIS_ENVOI = 5;
export const ENVOI_OFFERT_DES = 50;

const entier = (v, max) => Math.min(Math.max(parseInt(v, 10) || 0, 0), max);
const tailleParCle = (c) => TAILLES.find(t => t.cle === c) || null;

export function prixPhotos(n) {
  n = entier(n, PHOTOS_MAX);
  if (!n) return 0;
  return n * (n >= PHOTOS_DEGRESSIF_DES ? PRIX_PHOTO_DEGRESSIF : PRIX_PHOTO);
}

/* "Vous en avez 4 pour 60 euros ; a 5, c'est 50." On ne le dit que
   lorsque c'est vrai et avantageux pour elle. */
export function conseilPhotos(n) {
  n = entier(n, PHOTOS_MAX);
  if (!n || n >= PHOTOS_DEGRESSIF_DES) return null;
  const ici = prixPhotos(n);
  const palier = prixPhotos(PHOTOS_DEGRESSIF_DES);
  if (palier >= ici) return null;
  return { vers: PHOTOS_DEGRESSIF_DES, prix: palier, economie: ici - palier };
}

/* Ce que la page a le droit de savoir pour afficher la grille. Elle s'en
   sert pour montrer un total ; le serveur, lui, refait le calcul. */
export function grillePublique() {
  return {
    photo: PRIX_PHOTO,
    photoDes10: PRIX_PHOTO_DEGRESSIF,     // le prix a partir de grosDes photos (nom historique)
    grosDes: PHOTOS_DEGRESSIF_DES,
    photosMax: PHOTOS_MAX,
    album: PRIX_ALBUM_PANIER,
    albumsMax: ALBUMS_MAX,
    tailles: TAILLES.map(t => ({ ...t })),
    tiragesMax: TIRAGES_MAX,
    envoi: FRAIS_ENVOI,
    envoiOffertDes: ENVOI_OFFERT_DES,
  };
}

const propre = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

/* Le panier, recalcule de bout en bout a partir des quantites.
   `choix` vient du navigateur : on n'en garde que des nombres et du texte,
   jamais un prix. `extras` dit ce que Matt a accepte de proposer sur ce
   lien : demander un album sur un lien qui n'en propose pas ne cree pas de
   ligne, meme en forgeant la requete. */
export function calculerPanier({ formules = [], extras = {}, choix = {} }) {
  const lignes = [];
  const erreurs = [];

  /* 1. la montee en gamme : une seule, jamais deux */
  const formule = formules.find(f => f && f.id === String(choix.formule || "")) || null;
  if (formule) {
    lignes.push({
      cle: "formule", libelle: formule.titre, detail: "",
      quantite: 1, montant: Number(formule.montant) || 0,
    });
  }

  /* 2. les photos retouchees */
  if (extras.photos) {
    const n = entier(choix.photos, PHOTOS_MAX);
    if (n > 0) {
      lignes.push({
        cle: "photos",
        libelle: n + " photo" + (n > 1 ? "s" : "") + " retouchée" + (n > 1 ? "s" : "") + " en plus",
        detail: n >= PHOTOS_DEGRESSIF_DES ? PRIX_PHOTO_DEGRESSIF + " € l'unité, à partir de " + PHOTOS_DEGRESSIF_DES
              : PRIX_PHOTO + " € l'unité",
        quantite: n, montant: prixPhotos(n),
      });
    }
  }

  /* 3. l'album */
  if (extras.album) {
    const n = entier(choix.album, ALBUMS_MAX);
    if (n > 0) {
      lignes.push({
        cle: "album", libelle: n > 1 ? n + " albums photo imprimés" : "Album photo imprimé",
        detail: n > 1 ? PRIX_ALBUM_PANIER + " € l'unité" : "",
        quantite: n, montant: n * PRIX_ALBUM_PANIER,
      });
    }
  }

  /* 4. les tirages papier, taille par taille */
  let totalTirages = 0, nbTirages = 0;
  if (extras.tirages) {
    const q = (choix.tirages && typeof choix.tirages === "object") ? choix.tirages : {};
    const num = (choix.numeros && typeof choix.numeros === "object") ? choix.numeros : {};
    TAILLES.forEach(t => {
      const n = entier(q[t.cle], TIRAGES_MAX);
      if (!n) return;
      const numeros = propre(num[t.cle], 200);
      /* Sans les numeros, Matt ne saurait pas quoi imprimer : on refuse
         plutot que d'encaisser une commande inexecutable. */
      if (!numeros) erreurs.push("Indiquez les numéros des photos à tirer en " + t.nom + ".");
      const montant = n * t.prix;
      totalTirages += montant; nbTirages += n;
      lignes.push({
        cle: "tirage:" + t.cle,
        libelle: n + " tirage" + (n > 1 ? "s" : "") + " " + t.nom,
        detail: numeros ? "photo" + (n > 1 ? "s" : "") + " n° " + numeros : "",
        quantite: n, montant,
      });
    });
  }

  /* 5. l'envoi, uniquement s'il y a du papier a poster */
  const envoiOffert = totalTirages >= ENVOI_OFFERT_DES;
  if (nbTirages > 0 && !envoiOffert) {
    lignes.push({
      cle: "envoi", libelle: "Envoi postal", detail: "offert à partir de " + ENVOI_OFFERT_DES + " € de tirages",
      quantite: 1, montant: FRAIS_ENVOI,
    });
  }

  /* 6. l'adresse, uniquement s'il y a du papier a poster */
  const a = (choix.adresse && typeof choix.adresse === "object") ? choix.adresse : {};
  const adresse = {
    nom: propre(a.nom, 80), ligne1: propre(a.ligne1, 120), ligne2: propre(a.ligne2, 120),
    cp: propre(a.cp, 12), ville: propre(a.ville, 80),
  };
  if (nbTirages > 0) {
    if (!adresse.nom) erreurs.push("Indiquez le nom inscrit sur la boîte aux lettres.");
    if (!adresse.ligne1) erreurs.push("Indiquez l'adresse postale.");
    if (!adresse.cp || !adresse.ville) erreurs.push("Indiquez le code postal et la ville.");
  }

  const total = lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0);
  return {
    lignes, total, erreurs,
    envoiOffert: nbTirages > 0 && envoiOffert,
    adresse: nbTirages > 0 ? adresse : null,
    aDuPapier: nbTirages > 0,
  };
}

/* Le cout des tirages seuls, envoi compris. Sert au comptoir du lien de
   paiement ET a la reservation sur le site : une seule grille, un seul
   calcul. calculerPanier garde sa propre boucle parce qu'il doit aussi
   coller les numeros de photos a chaque ligne, mais les PRIX viennent des
   memes constantes. */
export function prixTirages(tirages) {
  const q = (tirages && typeof tirages === "object") ? tirages : {};
  const lignes = [];
  let papier = 0, nb = 0;
  TAILLES.forEach(t => {
    const n = entier(q[t.cle], TIRAGES_MAX);
    if (!n) return;
    const montant = n * t.prix;
    papier += montant; nb += n;
    lignes.push({ cle: t.cle, nom: t.nom, quantite: n, montant });
  });
  const envoi = (nb > 0 && papier < ENVOI_OFFERT_DES) ? FRAIS_ENVOI : 0;
  return { lignes, nb, papier, envoi, total: papier + envoi };
}

/* Des tirages postes a d'autres adresses, depuis la galerie ("Envoyer des
   tirages a d'autres personnes"). Chaque adresse est un colis de plus que
   Matt paie a la poste : les frais d'envoi s'appliquent a CHACUNE, sans le
   seuil d'envoi offert, qui ne vaut que pour le colis de la cliente. Choix
   de Matt, 20/10/2026.
   `envois` vient de autresEnvois (mbs-galeries.mjs), deja nettoye : des
   quantites par taille et les numeros des photos, jamais un prix. */
export function lignesAutresEnvois(envois) {
  const lignes = [];
  (Array.isArray(envois) ? envois : []).forEach((e, i) => {
    const qui = propre(e && e.adresse && e.adresse.nom, 60) || "l'adresse n° " + (i + 1);
    let nb = 0;
    TAILLES.forEach(t => {
      const n = entier(e && e.totaux && e.totaux[t.cle], TIRAGES_MAX);
      if (!n) return;
      nb += n;
      const numeros = propre(e.numeros && e.numeros[t.cle], 200);
      lignes.push({
        cle: "tirage:" + t.cle + ":" + (i + 1),
        libelle: n + " tirage" + (n > 1 ? "s" : "") + " " + t.nom + " pour " + qui,
        detail: numeros ? "photo" + (n > 1 ? "s" : "") + " n° " + numeros : "",
        quantite: n, montant: n * t.prix,
      });
    });
    if (nb) lignes.push({ cle: "envoi:" + (i + 1), libelle: "Envoi postal à " + qui, detail: "",
                          quantite: 1, montant: FRAIS_ENVOI });
  });
  return lignes;
}

/* Une ligne de resume, pour le CRM et les notifications. */
export function resumePanier(panier) {
  return (panier.lignes || []).map(l => l.libelle).join(" · ") || "Complément";
}
