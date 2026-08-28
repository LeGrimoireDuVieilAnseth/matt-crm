// netlify/galerie-lib.mjs
// Ou se trouve chaque galerie des deux sites, et comment s'y ecrit une
// photo. Separe de la fonction pour pouvoir etre teste hors ligne : ce
// code reecrit des fichiers de sites en production, il vaut mieux
// verifier qu'il rend exactement le fichier d'origine quand on lui
// redonne les memes photos.

export const PROPRIETAIRE = "LeGrimoireDuVieilAnseth";
export const BRANCHE = "main";

export function echapper(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const SITES = {
  "maison-lumiere": {
    nom: "Maison Lumiere",
    depot: "Maison-Lumi-re",
    fichier: "index.html",
    dossier: "images/galerie",
    prefixe: "galerie",
    galeries: {
      principale: {
        nom: "Galerie mariage",
        debut: "<!-- GALERIE:DEBUT -->",
        fin: "<!-- GALERIE:FIN -->",
        altParDefaut: "Photo de mariage Maison Lumiere",
        ligne: (chemin, alt) =>
          `      <figure><img loading="lazy" src="${chemin}" alt="${echapper(alt)}"></figure>`,
        extraire: (bloc) => [...bloc.matchAll(/src="([^"]+)"[^>]*alt="([^"]*)"/g)]
          .map(m => ({ chemin: m[1], alt: m[2] })),
      },
    },
  },
  "mybabyshoot": {
    nom: "Mybabyshoot",
    depot: "Mybabyshoot",
    fichier: "js/app.js",
    dossier: "images",
    prefixe: "photo",
    galeries: {
      bebe:      { nom: "Bebe et nouveau-ne", variable: "PHOTOS_BEBE" },
      grossesse: { nom: "Grossesse",          variable: "PHOTOS_GROSSESSE" },
    },
  },
};

/* Les deux galeries Mybabyshoot sont des tableaux JavaScript : meme
   ecriture, seul le nom de la variable change. */
for (const [cle, g] of Object.entries(SITES.mybabyshoot.galeries)) {
  const majuscule = cle.toUpperCase();
  g.debut = `/* GALERIE-${majuscule}:DEBUT */`;
  g.fin   = `/* GALERIE-${majuscule}:FIN */`;
  g.ligne = (chemin) => `  '${chemin}',`;
  g.entete = () => `const ${g.variable} = [`;
  g.pied   = () => `];`;
  g.extraire = (bloc) => [...bloc.matchAll(/'([^']+)'/g)].map(m => ({ chemin: m[1], alt: "" }));
}

export function config(site, galerie) {
  const s = SITES[site];
  if (!s) throw new Error("Site inconnu : " + site);
  if (!galerie) return { s, g: null };
  const g = s.galeries[galerie];
  if (!g) throw new Error("Galerie inconnue : " + galerie);
  return { s, g };
}

/* Le contenu entre les deux reperes, reperes exclus. */
export function lireBloc(contenu, debut, fin) {
  const i = contenu.indexOf(debut);
  if (i === -1) throw new Error("Repere de debut introuvable : " + debut);
  const j = contenu.indexOf(fin, i);
  if (j === -1) throw new Error("Repere de fin introuvable : " + fin);
  return contenu.slice(contenu.indexOf("\n", i) + 1, contenu.lastIndexOf("\n", j) + 1);
}

/* Remplace ce qui est entre les reperes sans toucher aux reperes ni au
   reste du fichier. */
export function remplacerBloc(contenu, debut, fin, nouveau) {
  const i = contenu.indexOf(debut);
  if (i === -1) throw new Error("Repere de debut introuvable : " + debut);
  const j = contenu.indexOf(fin, i);
  if (j === -1) throw new Error("Repere de fin introuvable : " + fin);
  const tete  = contenu.slice(0, contenu.indexOf("\n", i) + 1);
  const queue = contenu.slice(contenu.lastIndexOf("\n", j) + 1);
  return tete + nouveau + (nouveau.endsWith("\n") ? "" : "\n") + queue;
}

/* Le bloc a ecrire pour une liste de photos ordonnee. */
export function construireBloc(g, photos) {
  if (g.entete) {
    return [g.entete(), ...photos.map(p => g.ligne(p.chemin)), g.pied()].join("\n");
  }
  return photos.map(p => g.ligne(p.chemin, p.alt || g.altParDefaut)).join("\n");
}

/* Un nom de fichier sur : pas de chemin, pas d'accent, extension connue. */
export function nomAccepte(nom) {
  return /^[a-z0-9][a-z0-9._-]*\.(jpg|jpeg|png|webp)$/i.test(nom);
}
