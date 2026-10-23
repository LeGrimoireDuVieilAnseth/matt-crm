// netlify/functions/mbs-galerie-cliente.js
// La galerie, cote cliente : la page galerie.html du site.
//
// A ne pas confondre avec mbs-galerie.js, qui garde l'ordre des photos de la
// galerie PUBLIQUE du site.
//
// PUBLIC, mais il faut CONNAITRE le jeton (16 caracteres tires au hasard).
// Ne renvoie jamais l'email ni la fiche du CRM : un lien de galerie se
// transfere a la famille.
//
//   GET  ?g=JETON                 : la galerie (photos, formule, selection)
//   GET  ?g=JETON&t=p001          : la vignette d'une photo
//   GET  ?g=JETON&v=p001          : l'apercu d'une photo
//   POST ?g=JETON {action:"coeurs", coeurs}            : garde les coeurs en cours
//   POST ?g=JETON {action:"valider", coeurs, tirages, adresse, paiement}
//
// LE PRIX EST CALCULE ICI, PAS RECU DU NAVIGATEUR : la page n'envoie que des
// identifiants de photos et des quantites. Une commande a payer devient un
// lien de paiement, et suit le chemin de tous les liens jusqu'a la facture.
import Stripe from "stripe";
import { galerieStore, lireGalerie, enregistrer, vuePublique, estExpiree, normaliserJeton, completerFormats,
         idPhotoValide, coeursPropres, photosEnPlus, tiragesParTaille, texteSelection, autresEnvois,
         quotaRestant, nomFormuleDe, PHOTOS_MAX_GALERIE } from "../mbs-galeries.mjs";
import { calculerPanier, lignesAutresEnvois, grillePublique, TAILLES, PHOTOS_MAX, TIRAGES_MAX } from "../mbs-panier.mjs";
import { lienStore, creerLien, memoriserPanier, LIEN_MIN, LIEN_MAX, LIEN_SEUIL_3X } from "../mbs-liens.mjs";
import { ouvrirSessionPanier } from "../mbs-paiement-panier.mjs";
import { porteFermee, noterEchec, LIMITE_CODES } from "../mbs-garde.mjs";
import { crmStore, loadData, uid } from "../mbs-lib.mjs";
import { notifyAll } from "../push-lib.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const siteUrl = () =>
  (process.env.MBS_SITE_URL || "https://www.mybabyshoot.fr").replace(/\/+$/, "");

const MESSAGE_TROP = "Trop d'essais avec des liens inconnus. Réessayez dans une heure, ou appelez le 06 47 76 54 17.";

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const jeton = normaliserJeton(url.searchParams.get("g"));
  const store = galerieStore();

  /* ---------- les images ----------
     Une seule lecture : l'image elle-meme. Pas de lecture de la galerie ni
     du compteur d'essais, pour que 400 vignettes ne coutent pas 1 200
     operations. Une galerie expiree a de toute facon ete effacee. Cache
     navigateur d'une semaine, prive : une cliente qui revient ne
     retelecharge rien, et aucun cache partage ne garde ses photos. */
  const t = url.searchParams.get("t"), v = url.searchParams.get("v");
  if (request.method === "GET" && (t || v)) {
    const id = t || v;
    if (jeton.length !== 16 || !idPhotoValide(id)) return new Response("", { status: 404, headers: cors });
    let buf = null;
    try { buf = await store.get((t ? "t-" : "v-") + jeton + "-" + id, { type: "arrayBuffer" }); } catch (e) {}
    if (!buf) return new Response("", { status: 404, headers: cors });
    return new Response(buf, { headers: { ...cors, "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=604800, immutable" } });
  }

  /* ---------- la galerie ---------- */
  if (await porteFermee("galerie", request, LIMITE_CODES))
    return json({ ok: false, erreur: "trop", message: MESSAGE_TROP }, 429);
  const g = await lireGalerie(store, jeton);
  if (!g) {
    await noterEchec("galerie", request, LIMITE_CODES);
    return json({ ok: false, erreur: "introuvable" }, 404);
  }
  if (estExpiree(g)) return json({ ok: false, erreur: "expiree" }, 410);
  /* Matt est encore en train de deposer les photos. */
  if (g.statut === "preparation") return json({ ok: false, erreur: "preparation" }, 409);

  if (request.method === "GET") {
    /* La premiere ouverture : Matt sait ainsi que le lien a ete vu. Sauf
       son propre apercu depuis le CRM (&apercu=1), qui ne doit pas faire
       croire que la cliente est passee. */
    let change = false;
    if (!g.vueAt && url.searchParams.get("apercu") !== "1") { g.vueAt = Date.now(); change = true; }
    /* Une galerie preparee avant le 20/10/2026 : ses formats, lus une fois. */
    try { if (await completerFormats(store, g)) change = true; } catch (e) {}
    if (change) { try { await enregistrer(store, g); } catch (e) {} }
    return json({ ok: true, galerie: vuePublique(g), grille: grillePublique() });
  }
  if (request.method !== "POST") return json({ ok: false, erreur: "methode" }, 405);

  let corps = {};
  try { corps = await request.json(); } catch (e) {}

  /* Une selection validee, et payee s'il y avait a payer, ne se modifie
     plus en ligne : Matt a peut-etre deja commence les retouches. Une
     selection en attente de paiement, elle, peut encore changer. */
  const verrouillee = g.selection && !g.selection.enAttente;
  /* Ce qui reste compris : tout le total, sauf dans une galerie a deux
     seances ou un premier choix en a deja pris une part. */
  const restant = quotaRestant(g);
  const plafond = restant + PHOTOS_MAX;

  /* ---------- les coeurs en cours ----------
     Gardes cote serveur au fil du choix : la cliente retrouve sa selection
     sur son telephone comme sur son ordinateur, et la famille voit les
     memes coeurs. */
  if (corps.action === "coeurs") {
    if (verrouillee) return json({ ok: false, erreur: "validee" }, 409);
    g.coeurs = coeursPropres(g, corps.coeurs).slice(0, g.quota ? plafond : PHOTOS_MAX_GALERIE);
    await enregistrer(store, g);
    return json({ ok: true, coeurs: g.coeurs });
  }

  if (corps.action !== "valider") return json({ ok: false, erreur: "action" }, 400);
  if (verrouillee) return json({ ok: false, erreur: "validee" }, 409);

  const coeurs = coeursPropres(g, corps.coeurs);
  const enPlus = photosEnPlus(g, coeurs.length);
  if (g.quota && enPlus > PHOTOS_MAX) {
    return json({ ok: false, erreur: "trop_de_photos", messages: ["Vous pouvez choisir jusqu'à "
      + plafond + " photos : " + restant + " comprises dans votre formule, et " + PHOTOS_MAX + " en plus."] }, 400);
  }
  const tir = tiragesParTaille(g, corps.tirages, TAILLES);
  const aSonPapier = Object.keys(tir.totaux).length > 0;
  /* Les tirages envoyes a d'autres personnes, chacun a son adresse. */
  const autres = autresEnvois(g, corps.envois, TAILLES);
  if (autres.erreurs.length) return json({ ok: false, erreur: "incomplet", messages: autres.erreurs }, 400);
  const aDuPapier = aSonPapier || autres.envois.length > 0;
  /* Le panier ramene chaque taille a TIRAGES_MAX sans rien dire : 40 tirages
     demandes en 20 x 30 en auraient fait payer 30. On refuse plutot. Le
     plafond vaut pour la commande entiere, tous envois confondus. */
  const parTaille = { ...tir.totaux };
  autres.envois.forEach(e => Object.entries(e.totaux).forEach(([k, n]) => { parTaille[k] = (parTaille[k] || 0) + n; }));
  const tropDe = TAILLES.filter(t => (parTaille[t.cle] || 0) > TIRAGES_MAX);
  if (tropDe.length) {
    return json({ ok: false, erreur: "trop_de_tirages", messages: tropDe.map(t =>
      "Au plus " + TIRAGES_MAX + " tirages en " + t.nom + " par commande. Pour davantage, appelez Matteo au 06 47 76 54 17.") }, 400);
  }
  if (!coeurs.length && !aDuPapier && g.quota) {
    return json({ ok: false, erreur: "vide", messages: ["Choisissez vos photos avant de valider."] }, 400);
  }

  /* Le panier du comptoir, recalcule ici. Les photos comprises dans la
     formule n'y entrent pas : elles sont deja payees. */
  const panierSien = calculerPanier({
    formules: [],
    extras: { photos: enPlus > 0, tirages: aSonPapier },
    choix: { photos: enPlus, tirages: tir.totaux, numeros: tir.numeros, adresse: corps.adresse }
  });
  if (panierSien.erreurs.length) return json({ ok: false, erreur: "incomplet", messages: panierSien.erreurs }, 400);
  /* Les autres envois s'ajoutent en lignes du meme panier : un seul
     paiement, une seule facture, un seul rappel. */
  const lignesAutres = lignesAutresEnvois(autres.envois);
  const panier = { ...panierSien, lignes: [...panierSien.lignes, ...lignesAutres],
                   total: panierSien.total + lignesAutres.reduce((s, l) => s + l.montant, 0) };
  if (panier.total > LIEN_MAX)
    return json({ ok: false, erreur: "trop_haut", messages: ["Ce total dépasse ce qui peut être réglé en ligne. Appelez Matteo au 06 47 76 54 17."] }, 400);

  const now = Date.now();
  const tiragesTexte = Object.entries(tir.numeros)
    .map(([cle, n]) => ((TAILLES.find(x => x.cle === cle) || {}).nom || cle) + " : " + n).join("\n");
  const adresseTexte = panier.adresse
    ? [panier.adresse.nom, panier.adresse.ligne1, panier.adresse.ligne2,
       [panier.adresse.cp, panier.adresse.ville].filter(Boolean).join(" ")].filter(Boolean).join("\n")
    : "";

  /* Une selection en attente de paiement, puis modifiee : le lien d'avant
     ne doit plus etre payable, sinon deux commandes pourraient aboutir. */
  const lstore = lienStore();
  if (g.selection && g.selection.enAttente && g.selection.lienCode) {
    try {
      const ancien = await lstore.get("l-" + g.selection.lienCode, { type: "json" });
      if (ancien && ancien.statut !== "paye") { ancien.statut = "annule"; await lstore.setJSON("l-" + ancien.code, ancien); }
    } catch (e) {}
  }

  g.coeurs = coeurs;
  g.selection = {
    coeurs, tirages: corps.tirages && typeof corps.tirages === "object" ? corps.tirages : {},
    tiragesTexte, adresse: panier.adresse, adresseTexte,
    envois: autres.envois.map(e => ({ adresse: e.adresse, adresseTexte: e.adresseTexte,
                                      tirages: e.tirages, tiragesTexte: e.tiragesTexte, nb: e.nb })),
    enPlus, comprises: g.quota ? Math.min(coeurs.length, restant) : 0, montant: panier.total, at: now,
    enAttente: panier.total > 0, paye: false, lienCode: "",
  };

  /* ---------- rien a payer : la selection part tout de suite ---------- */
  if (panier.total <= 0) {
    g.statut = "choisie";
    await enregistrer(store, g);
    await prevenirMatt(g, now);
    return json({ ok: true, valide: true, galerie: vuePublique(g) });
  }

  if (panier.total < LIEN_MIN)
    return json({ ok: false, erreur: "trop_bas", messages: ["Le paiement en ligne commence à " + LIEN_MIN + " €."] }, 400);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ ok: false, erreur: "stripe" }, 503);

  /* ---------- a payer : la commande devient un lien de paiement ----------
     Le webhook le traitera comme tous les liens (facture, recette, rappel
     des tirages) et reconnaitra la galerie grace au champ "galerie". */
  const lien = await creerLien(lstore, {
    clientId: g.clientId, prenom: g.prenom, nom: g.nom, email: g.email,
    montant: 0, libelle: "Galerie", extras: { photos: enPlus > 0, tirages: aDuPapier }, now
  });
  if (!lien) return json({ ok: false, erreur: "lien" }, 500);
  lien.galerie = g.jeton;
  await lstore.setJSON("l-" + lien.code, lien);

  g.selection.lienCode = lien.code;
  g.statut = "attente_paiement";
  await enregistrer(store, g);

  const troisFois = String(corps.paiement || "") === "3x" && panier.total >= LIEN_SEUIL_3X;
  try {
    const site = siteUrl();
    const session = await ouvrirSessionPanier(new Stripe(secret), {
      lien, panier, troisFois, site,
      retourOk: site + "/galerie.html?g=" + g.jeton + "&ok=1",
      retourAnnule: site + "/galerie.html?g=" + g.jeton
    });
    await memoriserPanier(lstore, lien, session.id, panier);
    return json({ ok: true, url: session.url });
  } catch (e) {
    return json({ ok: false, erreur: "stripe", message: String((e && e.message) || e) }, 502);
  }
};

/* Une selection sans rien a payer : le webhook n'interviendra jamais, c'est
   donc ici que Matt est prevenu. Un rappel plutot qu'une simple
   notification : une notification se rate, un rappel reste jusqu'a ce
   qu'il le coche. */
async function prevenirMatt(g, now) {
  const nom = [g.prenom, g.nom].filter(Boolean).join(" ") || "Une cliente";
  try {
    const store = crmStore();
    const data = await loadData(store);
    data.taches = data.taches || [];
    data.taches.push({
      id: uid(), done: false,
      title: "Galerie : sélection de " + nom,
      dueDate: new Date(now).toISOString().slice(0, 10),
      priority: "Haute", clientId: g.clientId || "",
      notes: texteSelection(g) + "\n\nLes miniatures et les numéros : CRM > Galeries.",
      galerie: g.jeton
    });
    data.t = now;
    await store.setJSON("data", data);
  } catch (e) {}
  try {
    const s = g.selection, n = s.coeurs.length;
    await notifyAll("Sélection reçue · " + nom,
      n + " photo" + (n > 1 ? "s" : "") + " choisie" + (n > 1 ? "s" : "")
      + (g.quota ? " (" + s.comprises + " comprise" + (s.comprises > 1 ? "s" : "") + (s.enPlus ? ", " + s.enPlus + " en plus" : "")
                   + ", " + nomFormuleDe(g) + ")" : "") + ".", "/");
  } catch (e) {}
}

export const config = { path: "/.netlify/functions/mbs-galerie-cliente" };
