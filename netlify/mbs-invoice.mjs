// netlify/mbs-invoice.mjs
// Genere une facture d'acompte en PDF (pdf-lib, pur JS, sans fichier de police
// externe : parfait en serverless) et fournit un numero de facture continu.
import { getStore } from "@netlify/blobs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { TARIFS, PRIX_PHOTO_SUPP, PRIX_ALBUM, prixPaireDuo, typeLabelFr } from "./mbs-lib.mjs";
import { prixTirages } from "./mbs-panier.mjs";
import nodemailer from "nodemailer";

// Emetteur (auto-entrepreneur, sans TVA)
const ISSUER = {
  enseigne: "Mybabyshoot",
  nom: "Matteo Guerra",
  adresse: "16 chemin du Buisset, 69350 La Mulatière",
  siret: "807 463 443",
  tel: "06 47 76 54 17",
  email: "mybabyshoot.contact@gmail.com",
  mentionTva: "TVA non applicable, art. 293 B du CGI"
};

// Numero de facture continu, remis a 1 chaque annee, stocke dans un blob
// dedie (jamais ecrase par le CRM). Format MBS-AAAA-NNN.
export async function nextInvoiceNumber(){
  const store = getStore({ name: "mbs-invoices", consistency: "strong" });
  const year = new Date().getFullYear();
  let s = (await store.get("seq", { type: "json" })) || { year, n: 0 };
  if (s.year !== year) s = { year, n: 0 };
  s.n += 1;
  await store.setJSON("seq", s);
  return "MBS-" + year + "-" + String(s.n).padStart(3, "0");
}

function eur(n){ return Number(n).toFixed(2).replace(".", ",") + " €"; }

/* Le libelle de seance arrive sous deux formes.
   Depuis le site : "Grossesse", "Naissance", "Grossesse + naissance".
   Depuis le CRM  : "Seance grossesse", "Naissance / nouveau-ne", ou les
   valeurs ne sont jamais accentuees, exprès, pour ne pas casser les filtres.

   La facture ecrivait "Séance " + le libelle brut, ce qui donnait
   "Séance Seance grossesse" : le mot deux fois, dont une sans accent, sur un
   document que la cliente garde. On accentue ici, et on ne prefixe "Séance"
   que si le mot n'est pas deja la. */
const LIBELLES_SEANCE = {
  "seance grossesse":        "Séance photo grossesse",
  "grossesse":               "Séance photo grossesse",
  "naissance / nouveau-ne":  "Séance photo naissance",
  "naissance":               "Séance photo naissance",
  "bebe":                    "Séance photo bébé",
  "bébé":                    "Séance photo bébé",
  "grossesse + naissance":   "Séance photo grossesse + naissance",
  "suivi bebe":              "Séance photo suivi bébé",
  "famille":                 "Séance photo famille",
  "smash cake":              "Séance photo smash cake"
};

/* Le detail d'une seance, reconstruit depuis les metadonnees Stripe. Les
   montants ne viennent JAMAIS des metadonnees : on les relit dans la
   grille, pour que la facture dise exactement ce qui a ete preleve.
   Renvoie [] si on ne sait rien, et l'appelant retombe alors sur la ligne
   unique d'avant. */
const NOM_GAMME = { essentielle: "Essentielle", confort: "Confort", prestige: "Prestige" };

export function lignesSeance(md = {}){
  const L = [];
  const paire = String(md.duo || "").split("+");
  const aD = TARIFS.simple[paire[0]], aN = TARIFS.simple[paire[1]];

  if (aD && aN) {
    /* Le pack : une ligne par seance, puis la remise en negatif. Un seul
       montant global cacherait la formule choisie pour chacune. */
    L.push({ libelle: "Séance grossesse, formule " + NOM_GAMME[paire[0]], montant: aD });
    L.push({ libelle: "Séance naissance, formule " + NOM_GAMME[paire[1]], montant: aN });
    const p = prixPaireDuo(paire[0], paire[1]);
    if (p && p.remise > 0) L.push({ libelle: "Remise pack 2 séances", montant: -p.remise });
  } else {
    const base = TARIFS.simple[String(md.gamme || "")];
    if (base) L.push({
      libelle: libelleSeance(typeLabelFr(md.type)) + ", formule " + NOM_GAMME[md.gamme],
      montant: base
    });
  }

  const n = Math.min(Math.max(parseInt(md.photos, 10) || 0, 0), 50);
  if (n > 0) L.push({
    libelle: n + " photo" + (n > 1 ? "s" : "") + " retouchée" + (n > 1 ? "s" : "") + " en supplément",
    montant: n * PRIX_PHOTO_SUPP
  });
  if (md.album === "1") L.push({ libelle: "Album photo imprimé", montant: PRIX_ALBUM });

  /* Les tirages : "20x30:2,40x60:1". Les quantites viennent de Stripe, les
     prix et les noms de la grille. */
  const q = {};
  String(md.tirages || "").split(",").forEach(x => {
    const [cle, nb] = x.split(":");
    const v = parseInt(nb, 10) || 0;
    if (cle && v > 0) q[cle] = v;
  });
  const tir = prixTirages(q);
  tir.lignes.forEach(l => L.push({
    libelle: l.quantite + " tirage" + (l.quantite > 1 ? "s" : "") + " " + l.nom, montant: l.montant
  }));
  if (tir.envoi > 0) L.push({ libelle: "Envoi postal des tirages", montant: tir.envoi });

  const frais = Number(md.fraisDepl) || 0;
  if (frais > 0) L.push({
    libelle: "Déplacement" + (md.lieuExt ? ", " + md.lieuExt : ""), montant: frais
  });

  const remise = Number(md.remise) || 0;
  if (remise > 0) L.push({
    libelle: md.coupon ? "Bon ou code de réduction" : "Remise", montant: -remise
  });

  return L;
}

export function libelleSeance(v){
  const brut = String(v == null ? "" : v).trim();
  if (!brut) return "Séance photo";
  const connu = LIBELLES_SEANCE[brut.toLowerCase()];
  if (connu) return connu;
  // Type ajoute plus tard : on retire un "Seance" ou "Séance photo" deja
  // present avant de prefixer, pour ne jamais ecrire le mot deux fois.
  const reste = brut.replace(/^s[ée]ance\b\s*(photo\b\s*)?/i, "").trim();
  return reste ? "Séance photo " + reste.toLowerCase() : "Séance photo";
}

/* ---------- Archivage ----------
   Les factures etaient generees puis envoyees par email, et perdues ensuite.
   On garde desormais chaque PDF dans le store "mbs-invoices" (cle pdf-<numero>)
   avec un index consultable. Non bloquant : un archivage rate ne doit jamais
   empecher l'envoi de la facture au client. */
export function invoiceStore(){
  return getStore({ name: "mbs-invoices", consistency: "strong" });
}

export async function saveInvoice({ number, kind, pdf, client, montant, dateStr, detail }){
  if (!number || !pdf) return false;
  try {
    const store = invoiceStore();
    await store.set("pdf-" + number, pdf);
    const idx = (await store.get("index", { type: "json" })) || [];
    if (!idx.some(e => e.number === number)) {
      idx.unshift({
        number,
        kind: kind || "acompte",              // acompte | solde | cadeau
        dateStr: dateStr || new Date().toLocaleDateString("fr-FR"),
        createdAt: Date.now(),
        client: (client && client.name) || "",
        email: (client && client.email) || "",
        montant: Number(montant) || 0,
        detail: detail || ""
      });
      await store.setJSON("index", idx.slice(0, 2000));
    }
    return true;
  } catch (e) { return false; }
}

// inv : { number, dateStr, client:{name,email}, typeLabel, seanceDateFr, time, acompte, total }
export async function makeInvoicePdf(inv){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842, M = 50;
  const ink = rgb(0.16, 0.12, 0.07), soft = rgb(0.45, 0.40, 0.33), line = rgb(0.85, 0.80, 0.72);
  const T = (x, yTop, str, size, f, c) => page.drawText(String(str), { x, y: H - yTop, size, font: f || font, color: c || ink });

  // Emetteur
  T(M, 62, ISSUER.enseigne, 22, bold);
  T(M, 84, ISSUER.nom, 10, font, soft);
  T(M, 98, ISSUER.adresse, 10, font, soft);
  T(M, 112, "SIRET " + ISSUER.siret, 10, font, soft);
  T(M, 126, ISSUER.tel + "  ·  " + ISSUER.email, 10, font, soft);

  // Bloc facture (droite)
  T(360, 62, "FACTURE D'ACOMPTE", 15, bold);
  T(360, 84, "Facture n° " + inv.number, 10, font, soft);
  T(360, 98, "Date : " + inv.dateStr, 10, font, soft);

  // separateur
  page.drawLine({ start: { x: M, y: H - 150 }, end: { x: 545, y: H - 150 }, thickness: 1, color: line });

  // Client
  T(M, 182, "Facturé à", 10, bold, soft);
  T(M, 198, inv.client.name || "Client", 12, bold);
  if (inv.client.email) T(M, 214, inv.client.email, 10, font, soft);

  // Tableau
  const yTable = 262;
  T(M, yTable, "Description", 10, bold, soft);
  T(430, yTable, "Montant", 10, bold, soft);
  page.drawLine({ start: { x: M, y: H - (yTable + 8) }, end: { x: 545, y: H - (yTable + 8) }, thickness: 0.8, color: line });

  /* Le detail de la prestation, ligne par ligne. Sans lui la cliente
     voyait un montant et devait nous croire sur parole, alors qu'elle a pu
     prendre un album, des photos en plus et des tirages. */
  const lignes = Array.isArray(inv.lignes) ? inv.lignes : [];
  let y = yTable + 30;
  if (lignes.length) {
    T(M, y, libelleSeance(inv.typeLabel) + " du " + inv.seanceDateFr + " à " + inv.time, 11, bold);
    y += 16;
    lignes.forEach(l => {
      T(M + 10, y, l.libelle, 10, font, l.montant < 0 ? soft : ink);
      T(430, y, (l.montant < 0 ? "- " : "") + eur(Math.abs(l.montant)), 10, font, l.montant < 0 ? soft : ink);
      y += 16;
    });
    y += 2;
    T(M, y, "Total de la prestation", 10.5, bold);
    T(430, y, eur(inv.total), 10.5, bold);
    y += 20;
  } else {
    T(M, y, "Acompte - " + libelleSeance(inv.typeLabel), 11, font);
    T(M, y + 16, "du " + inv.seanceDateFr + " à " + inv.time + " (studio, La Mulatière)", 9.5, font, soft);
    T(430, y, eur(inv.acompte), 11, bold);
    y += 36;
  }

  page.drawLine({ start: { x: M, y: H - (y + 6) }, end: { x: 545, y: H - (y + 6) }, thickness: 0.8, color: line });

  // Total
  T(300, y + 32, "Acompte réglé", 11, bold);
  T(430, y + 32, eur(inv.acompte), 12, bold);

  // Mention TVA
  T(M, y + 70, ISSUER.mentionTva, 9.5, font, soft);

  // Note solde
  const reste = Math.max(0, Number(inv.total) - Number(inv.acompte));
  T(M, y + 100, "Acompte versé pour réserver la date de la séance.", 10, font);
  T(M, y + 116, "Solde de " + eur(reste) + " à régler le jour de la séance.", 10, font);

  // Pied de page
  T(M, 800, ISSUER.enseigne + " · " + ISSUER.nom + " · SIRET " + ISSUER.siret + " · " + ISSUER.mentionTva, 8, font, soft);

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/* Facture d'un bon cadeau : regle en totalite a l'achat, rien a encaisser
   ensuite. Le beneficiaire n'est pas nomme sur la facture, elle appartient
   a l'acheteur.
   inv : { number, dateStr, client:{name,email}, formule, seanceLabel, code, montant } */
export async function makeGiftInvoicePdf(inv){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842, M = 50;
  const ink = rgb(0.16, 0.12, 0.07), soft = rgb(0.45, 0.40, 0.33), line = rgb(0.85, 0.80, 0.72);
  const T = (x, yTop, str, size, f, c) => page.drawText(String(str), { x, y: H - yTop, size, font: f || font, color: c || ink });

  // Emetteur
  T(M, 62, ISSUER.enseigne, 22, bold);
  T(M, 84, ISSUER.nom, 10, font, soft);
  T(M, 98, ISSUER.adresse, 10, font, soft);
  T(M, 112, "SIRET " + ISSUER.siret, 10, font, soft);
  T(M, 126, ISSUER.tel + "  ·  " + ISSUER.email, 10, font, soft);

  // Bloc facture (droite)
  T(360, 62, "FACTURE", 15, bold);
  T(360, 84, "Facture n° " + inv.number, 10, font, soft);
  T(360, 98, "Date : " + inv.dateStr, 10, font, soft);

  page.drawLine({ start: { x: M, y: H - 150 }, end: { x: 545, y: H - 150 }, thickness: 1, color: line });

  // Client
  T(M, 182, "Facturé à", 10, bold, soft);
  T(M, 198, inv.client.name || "Client", 12, bold);
  if (inv.client.email) T(M, 214, inv.client.email, 10, font, soft);

  // Tableau
  const yTable = 262;
  T(M, yTable, "Description", 10, bold, soft);
  T(430, yTable, "Montant", 10, bold, soft);
  page.drawLine({ start: { x: M, y: H - (yTable + 8) }, end: { x: 545, y: H - (yTable + 8) }, thickness: 0.8, color: line });

  T(M, yTable + 30, "Bon cadeau - " + (inv.seanceLabel || "Séance photo"), 11, font);
  T(M, yTable + 46, "Formule " + (inv.formule || "") + " (studio, La Mulatière)", 9.5, font, soft);
  T(M, yTable + 62, "Code du bon : " + (inv.code || ""), 9.5, font, soft);
  T(430, yTable + 30, eur(inv.montant), 11, bold);

  page.drawLine({ start: { x: M, y: H - (yTable + 82) }, end: { x: 545, y: H - (yTable + 82) }, thickness: 0.8, color: line });

  // Total
  T(300, yTable + 108, "Total réglé", 11, bold);
  T(430, yTable + 108, eur(inv.montant), 12, bold);

  // Mention TVA
  T(M, yTable + 146, ISSUER.mentionTva, 9.5, font, soft);

  // Notes
  T(M, yTable + 176, "Réglé en totalité le " + inv.dateStr + " par carte bancaire.", 10, font);
  T(M, yTable + 192, "Bon valable 18 mois, à usage unique. La séance sera réservée par son", 10, font);
  T(M, yTable + 208, "bénéficiaire sur mybabyshoot.fr, sans aucun paiement supplémentaire.", 10, font);

  // Pied de page
  T(M, 800, ISSUER.enseigne + " · " + ISSUER.nom + " · SIRET " + ISSUER.siret + " · " + ISSUER.mentionTva, 8, font, soft);

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/* Facture d'un complement regle par lien de paiement.
   Elle ne parle ni d'acompte ni de solde : ce n'est pas une seance qu'on
   finit de payer, c'est un supplement autonome (passage a une formule
   superieure, tirage en plus, deplacement). Reutiliser la facture de solde
   aurait affiche un acompte imaginaire.
   inv : { number, dateStr, client:{name,email}, libelle, montant, troisFois } */
export async function makeComplementInvoicePdf(inv){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842, M = 50;
  const ink = rgb(0.16, 0.12, 0.07), soft = rgb(0.45, 0.40, 0.33), line = rgb(0.85, 0.80, 0.72);
  const T = (x, yTop, str, size, f, c) => page.drawText(String(str), { x, y: H - yTop, size, font: f || font, color: c || ink });
  const trait = (yTop) => page.drawLine({ start: { x: M, y: H - yTop }, end: { x: 545, y: H - yTop }, thickness: 0.8, color: line });

  T(M, 62, ISSUER.enseigne, 22, bold);
  T(M, 84, ISSUER.nom, 10, font, soft);
  T(M, 98, ISSUER.adresse, 10, font, soft);
  T(M, 112, "SIRET " + ISSUER.siret, 10, font, soft);
  T(M, 126, ISSUER.tel + "  ·  " + ISSUER.email, 10, font, soft);

  T(360, 62, "FACTURE", 15, bold);
  T(360, 84, "Facture n° " + inv.number, 10, font, soft);
  T(360, 98, "Date : " + inv.dateStr, 10, font, soft);

  page.drawLine({ start: { x: M, y: H - 150 }, end: { x: 545, y: H - 150 }, thickness: 1, color: line });

  T(M, 182, "Facturé à", 10, bold, soft);
  T(M, 198, inv.client.name || "Client", 12, bold);
  if (inv.client.email) T(M, 214, inv.client.email, 10, font, soft);

  /* Une facture d'avant le panier n'a qu'un libelle et un montant : on lui
     fabrique une ligne unique, et la mise en page ne change pas pour elle. */
  const lignes = (Array.isArray(inv.lignes) && inv.lignes.length)
    ? inv.lignes
    : [{ libelle: inv.libelle || "Complément", detail: "", montant: inv.montant }];
  const total = Number.isFinite(Number(inv.montant)) && Number(inv.montant) > 0
    ? Number(inv.montant)
    : lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0);

  const yTable = 262;
  T(M, yTable, "Description", 10, bold, soft);
  T(430, yTable, "Montant", 10, bold, soft);
  trait(yTable + 8);

  let y = yTable + 30;
  lignes.forEach(l => {
    T(M, y, String(l.libelle || "").slice(0, 62), 11, font);
    T(430, y, eur(l.montant), 11, bold);
    y += 14;
    if (l.detail) { T(M, y, String(l.detail).slice(0, 80), 9, font, soft); y += 13; }
    y += 7;
  });

  trait(y);
  T(300, y + 26, "Total réglé", 11, bold);
  T(430, y + 26, eur(total), 12, bold);
  y += 58;

  /* L'adresse d'envoi fait partie de la facture quand il y a du papier :
     c'est la preuve de ce qui a ete commande et ou ca part. */
  const a = inv.adresse;
  if (a && (a.ligne1 || a.ville)) {
    T(M, y, "Envoi des tirages", 10, bold, soft); y += 16;
    if (a.nom) { T(M, y, a.nom, 10.5, font); y += 14; }
    if (a.ligne1) { T(M, y, a.ligne1, 10.5, font); y += 14; }
    if (a.ligne2) { T(M, y, a.ligne2, 10.5, font); y += 14; }
    T(M, y, [a.cp, a.ville].filter(Boolean).join(" "), 10.5, font); y += 22;
  }

  T(M, y, ISSUER.mentionTva, 9.5, font, soft); y += 26;
  T(M, y, "Réglé en totalité le " + inv.dateStr +
    (inv.troisFois ? " en 3 fois sans frais." : " par carte bancaire."), 10, font);

  T(M, 800, ISSUER.enseigne + " · " + ISSUER.nom + " · SIRET " + ISSUER.siret + " · " + ISSUER.mentionTva, 8, font, soft);

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

// Facture de solde (finale) : rappelle l'acompte deja verse et le solde regle.
// inv : { number, dateStr, client:{name,email}, typeLabel, seanceDateFr, total, acompte }
export async function makeFinalInvoicePdf(inv){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842, M = 50;
  const ink = rgb(0.16, 0.12, 0.07), soft = rgb(0.45, 0.40, 0.33), line = rgb(0.85, 0.80, 0.72);
  const T = (x, yTop, str, size, f, c) => page.drawText(String(str), { x, y: H - yTop, size, font: f || font, color: c || ink });

  T(M, 62, ISSUER.enseigne, 22, bold);
  T(M, 84, ISSUER.nom, 10, font, soft);
  T(M, 98, ISSUER.adresse, 10, font, soft);
  T(M, 112, "SIRET " + ISSUER.siret, 10, font, soft);
  T(M, 126, ISSUER.tel + "  ·  " + ISSUER.email, 10, font, soft);

  T(360, 62, "FACTURE", 15, bold);
  T(360, 84, "Facture n° " + inv.number, 10, font, soft);
  T(360, 98, "Date : " + inv.dateStr, 10, font, soft);

  page.drawLine({ start: { x: M, y: H - 150 }, end: { x: 545, y: H - 150 }, thickness: 1, color: line });

  T(M, 182, "Facturé à", 10, bold, soft);
  T(M, 198, inv.client.name || "Client", 12, bold);
  if (inv.client.email) T(M, 214, inv.client.email, 10, font, soft);

  const yTable = 262;
  T(M, yTable, "Description", 10, bold, soft);
  T(430, yTable, "Montant", 10, bold, soft);
  page.drawLine({ start: { x: M, y: H - (yTable + 8) }, end: { x: 545, y: H - (yTable + 8) }, thickness: 0.8, color: line });

  /* Le detail de la prestation, quand on le connait. */
  const lignes = Array.isArray(inv.lignes) ? inv.lignes : [];
  let y = yTable + 30;
  if (lignes.length) {
    T(M, y, libelleSeance(inv.typeLabel) + " du " + inv.seanceDateFr, 11, bold);
    y += 16;
    lignes.forEach(l => {
      T(M + 10, y, l.libelle, 10, font, l.montant < 0 ? soft : ink);
      T(430, y, (l.montant < 0 ? "- " : "") + eur(Math.abs(l.montant)), 10, font, l.montant < 0 ? soft : ink);
      y += 16;
    });
    T(M, y, "Total de la prestation", 10.5, bold);
    T(430, y, eur(inv.total), 10.5, bold);
  } else {
    T(M, y, libelleSeance(inv.typeLabel) + " du " + inv.seanceDateFr, 11, font);
    T(430, y, eur(inv.total), 11, font);
  }

  // Regle en une fois : pas d'acompte anterieur a rappeler, donc pas de
  // ligne de deduction et pas de "solde", qui laisserait croire qu'il
  // restait quelque chose a payer.
  const acompteVerse = Math.max(0, Number(inv.acompte) || 0);
  if (acompteVerse > 0) {
    y += 22;
    T(M, y, "Acompte déjà versé", 11, font, soft);
    T(430, y, "- " + eur(acompteVerse), 11, font, soft);
  }
  page.drawLine({ start: { x: M, y: H - (y + 20) }, end: { x: 545, y: H - (y + 20) }, thickness: 0.8, color: line });

  T(300, y + 46, acompteVerse > 0 ? "Solde réglé" : "Total réglé", 11, bold);
  T(430, y + 46, eur(Math.max(0, Number(inv.total) - acompteVerse)), 12, bold);
  if (acompteVerse > 0) {
    T(300, y + 68, "Total prestation", 10, font, soft);
    T(430, y + 68, eur(inv.total), 10, font, soft);
  }

  T(M, y + 106, ISSUER.mentionTva, 9.5, font, soft);
  T(M, y + 136, "Prestation réglée intégralement. Merci de votre confiance.", 10, font);

  T(M, 800, ISSUER.enseigne + " · " + ISSUER.nom + " · SIRET " + ISSUER.siret + " · " + ISSUER.mentionTva, 8, font, soft);

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

// Envoi d'une facture par email (SMTP maison), avec copie a Matt (bcc).
export async function sendInvoiceMail({ to, subject, html, pdf, pdfName }){
  const host = process.env.MBS_SMTP_HOST, user = process.env.MBS_SMTP_USER, pass = process.env.MBS_SMTP_PASS;
  const from = process.env.MBS_FROM_EMAIL || user;
  if (!host || !user || !pass || !to) return false;
  const port = Number(process.env.MBS_SMTP_PORT || 465);
  const secure = process.env.MBS_SMTP_SECURE ? (process.env.MBS_SMTP_SECURE === "true") : (port === 465);
  const bcc = process.env.MBS_INVOICE_EMAIL || "mybabyshoot.contact@gmail.com";
  const attachments = pdf ? [{ filename: pdfName || "facture.pdf", content: pdf, contentType: "application/pdf" }] : [];
  const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  await transport.sendMail({ from, to, bcc, subject, html, attachments });
  return true;
}
