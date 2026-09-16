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

/* Photos retouchees supplementaires.
   1 a 4  : 15 euros piece.
   5 a 9  : une photo n'est pas facturee -> (n - 1) x 15.
   10 et + : 10 euros piece, sans photo offerte.

   Consequence a connaitre : 9 photos coutent 120 euros et 10 en coutent
   100. Le prix baisse en montant d'une photo. C'est la grille voulue par
   Matt ; la page le dit a la cliente au lieu de le laisser passer pour un
   bug, et ca l'invite a en prendre dix. Voir conseilPhotos(). */
export const PRIX_PHOTO = 15;
export const PRIX_PHOTO_DES_10 = 10;
export const PHOTOS_UNE_OFFERTE_DES = 5;
export const PHOTOS_GROS_DES = 10;
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
  if (n >= PHOTOS_GROS_DES) return n * PRIX_PHOTO_DES_10;
  if (n >= PHOTOS_UNE_OFFERTE_DES) return (n - 1) * PRIX_PHOTO;
  return n * PRIX_PHOTO;
}

/* "Vous en avez 9 pour 120 euros ; a 10, c'est 100." On ne le dit que
   lorsque c'est vrai et avantageux pour elle. */
export function conseilPhotos(n) {
  n = entier(n, PHOTOS_MAX);
  if (!n || n >= PHOTOS_GROS_DES) return null;
  const ici = prixPhotos(n);
  const dix = prixPhotos(PHOTOS_GROS_DES);
  if (dix >= ici) return null;
  return { vers: PHOTOS_GROS_DES, prix: dix, economie: ici - dix };
}

/* Ce que la page a le droit de savoir pour afficher la grille. Elle s'en
   sert pour montrer un total ; le serveur, lui, refait le calcul. */
export function grillePublique() {
  return {
    photo: PRIX_PHOTO,
    photoDes10: PRIX_PHOTO_DES_10,
    uneOfferteDes: PHOTOS_UNE_OFFERTE_DES,
    grosDes: PHOTOS_GROS_DES,
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
      const offerte = n >= PHOTOS_UNE_OFFERTE_DES && n < PHOTOS_GROS_DES;
      lignes.push({
        cle: "photos",
        libelle: n + " photo" + (n > 1 ? "s" : "") + " retouchée" + (n > 1 ? "s" : "") + " en plus",
        detail: n >= PHOTOS_GROS_DES ? PRIX_PHOTO_DES_10 + " € l'unité"
              : offerte ? PRIX_PHOTO + " € l'unité, une offerte"
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
      if (!numeros) erreurs.push("Indique les numéros des photos à tirer en " + t.nom + ".");
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
    if (!adresse.nom) erreurs.push("Indique le nom inscrit sur la boîte aux lettres.");
    if (!adresse.ligne1) erreurs.push("Indique l'adresse postale.");
    if (!adresse.cp || !adresse.ville) erreurs.push("Indique le code postal et la ville.");
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

/* Une ligne de resume, pour le CRM et les notifications. */
export function resumePanier(panier) {
  return (panier.lignes || []).map(l => l.libelle).join(" · ") || "Complément";
}
