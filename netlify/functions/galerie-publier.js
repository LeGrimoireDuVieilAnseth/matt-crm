// netlify/functions/galerie-publier.js
// Publie les galeries des deux sites depuis le CRM.
//
// Les photos sont deposees dans les depots GitHub, pas dans un stockage a
// part. Elles sont donc servies par le reseau de Netlify comme le reste du
// site (rapide et mis en cache), sauvegardees par GitHub et par la copie
// OneDrive, et chaque publication devient un commit qu'on peut relire ou
// annuler. Le prix a payer : une a deux minutes avant que ce soit visible,
// le temps que Netlify reconstruise.
//
// Protege par le mot de passe du CRM (CRM_KEY). Ecrit avec une cle GitHub
// rangee dans GITHUB_TOKEN (variable secrete Netlify, portee "Functions"),
// limitee aux deux depots et au seul droit Contents.
//
//   GET  ?site=X&galerie=Y                       : les photos actuellement en ligne
//   POST ?action=televerser {site,nom,contenu}   : depose UNE photo, rend son empreinte
//   POST ?action=publier    {site,galerie,photos}: un seul commit pour tout
//
// Le televersement est separe de la publication pour deux raisons : une
// requete Netlify est limitee en taille, et photo par photo permet
// d'afficher une progression. Rien n'est visible en ligne tant que
// "publier" n'a pas ete appele, et une publication = un seul commit, donc
// une seule reconstruction du site.
import { PROPRIETAIRE, BRANCHE, config, lireBloc, remplacerBloc,
         construireBloc, nomAccepte } from "../galerie-lib.mjs";

const API = "https://api.github.com";

const json = (corps, status = 200) =>
  new Response(JSON.stringify(corps), {
    status, headers: { "Content-Type": "application/json" },
  });

function autorise(request) {
  const attendu = process.env.CRM_KEY || "";
  if (!attendu) return true;
  return (request.headers.get("x-crm-key") || "") === attendu;
}

async function github(chemin, options = {}) {
  const cle = process.env.GITHUB_TOKEN;
  if (!cle) throw new Error("GITHUB_TOKEN absent des reglages Netlify");
  const r = await fetch(API + chemin, {
    ...options,
    headers: {
      "Authorization": "Bearer " + cle,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const texte = await r.text();
  if (!r.ok) {
    let detail = texte;
    try { detail = JSON.parse(texte).message || texte; } catch (_) {}
    if (r.status === 401 || r.status === 403) {
      detail = "la cle GitHub est refusee ou n'a pas le droit d'ecrire. " + detail;
    }
    throw new Error("GitHub " + r.status + " : " + detail);
  }
  return texte ? JSON.parse(texte) : null;
}

const lireFichier = async (s) => {
  const r = await github(`/repos/${PROPRIETAIRE}/${s.depot}/contents/${encodeURI(s.fichier)}?ref=${BRANCHE}`);
  return Buffer.from(r.content, "base64").toString("utf8");
};

export default async (request) => {
  if (!autorise(request)) return json({ ok: false, erreur: "non autorise" }, 401);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";

  try {
    /* ---- Ce qui est en ligne en ce moment ---- */
    if (request.method === "GET") {
      const { s, g } = config(url.searchParams.get("site"), url.searchParams.get("galerie"));
      const contenu = await lireFichier(s);
      return json({ ok: true, dossier: s.dossier, prefixe: s.prefixe,
                    photos: g.extraire(lireBloc(contenu, g.debut, g.fin)) });
    }

    if (request.method !== "POST") return json({ ok: false, erreur: "methode refusee" }, 405);
    const corps = await request.json();

    /* ---- Deposer une photo, sans rien publier ---- */
    if (action === "televerser") {
      const { s } = config(corps.site, null);
      if (!corps.nom || !corps.contenu) return json({ ok: false, erreur: "nom ou contenu manquant" }, 400);
      if (!nomAccepte(corps.nom)) return json({ ok: false, erreur: "nom de fichier refuse : " + corps.nom }, 400);
      const blob = await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: corps.contenu, encoding: "base64" }),
      });
      return json({ ok: true, sha: blob.sha, chemin: s.dossier + "/" + corps.nom });
    }

    /* ---- Publier : un seul commit ---- */
    if (action === "publier") {
      const { s, g } = config(corps.site, corps.galerie);
      const photos = Array.isArray(corps.photos) ? corps.photos : [];
      /* Une galerie vide est presque toujours une fausse manoeuvre, et
         elle laisserait un trou sur le site. On refuse. */
      if (!photos.length) return json({ ok: false, erreur: "galerie vide, publication refusee" }, 400);
      for (const p of photos) {
        if (!p || typeof p.chemin !== "string" || !p.chemin.startsWith(s.dossier + "/")) {
          return json({ ok: false, erreur: "chemin refuse : " + (p && p.chemin) }, 400);
        }
      }

      const ref = await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/ref/heads/${BRANCHE}`);
      const commitBase = await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/commits/${ref.object.sha}`);

      const contenu = await lireFichier(s);
      const nouveau = remplacerBloc(contenu, g.debut, g.fin, construireBloc(g, photos));
      if (nouveau === contenu && !photos.some(p => p.sha)) {
        return json({ ok: true, rien: true, message: "Rien n'a change, aucune publication necessaire." });
      }

      const blobFichier = await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: Buffer.from(nouveau, "utf8").toString("base64"), encoding: "base64" }),
      });

      const arbre = [{ path: s.fichier, mode: "100644", type: "blob", sha: blobFichier.sha }];
      for (const p of photos) {
        if (p.sha) arbre.push({ path: p.chemin, mode: "100644", type: "blob", sha: p.sha });
      }
      const nouvelArbre = await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: commitBase.tree.sha, tree: arbre }),
      });

      const nouvelles = photos.filter(p => p.sha).length;
      const titre = (corps.message || "").trim() ||
        (nouvelles ? nouvelles + " photo(s) ajoutee(s) a la galerie " + g.nom.toLowerCase()
                   : "Galerie " + g.nom.toLowerCase() + " reorganisee");
      const message = titre + "\n\n" +
        "Publie depuis l'ecran Galeries du CRM.\n" +
        photos.length + " photo(s) au total" + (nouvelles ? ", dont " + nouvelles + " nouvelle(s)" : "") + ".\n" +
        "Les photos sont compressees par le navigateur avant l'envoi.\n";

      const commit = await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: nouvelArbre.sha, parents: [ref.object.sha] }),
      });
      await github(`/repos/${PROPRIETAIRE}/${s.depot}/git/refs/heads/${BRANCHE}`, {
        method: "PATCH", body: JSON.stringify({ sha: commit.sha }),
      });

      return json({ ok: true, commit: commit.sha.slice(0, 7), total: photos.length, nouvelles,
        message: "Publie. Le site se met a jour dans une a deux minutes." });
    }

    return json({ ok: false, erreur: "action inconnue" }, 400);
  } catch (e) {
    return json({ ok: false, erreur: String(e.message || e) }, 500);
  }
};
