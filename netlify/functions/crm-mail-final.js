// netlify/functions/crm-mail-final.js
// Le mail de fin de prestation, declenche a la main depuis la fiche client :
// la galerie, le code faire-part, la demande d'avis, et la facture de solde
// en piece jointe.
//
// POST (protege par CRM_KEY) : { clientId, galerie } -> envoie le mail
//
// Le destinataire n'est jamais fourni par l'appelant : on le lit dans la
// fiche a partir de son identifiant. Meme avec la cle, cette fonction ne
// peut donc ecrire qu'a quelqu'un qui est deja client de Matt, et jamais
// servir a envoyer un message a une adresse quelconque.
//
// Elle ne modifie pas les donnees du CRM : c'est le CRM qui note l'envoi sur
// la fiche. Un seul ecrivain sur le blob, pas de course entre les deux.
import { crmStore, loadData } from "../mbs-lib.mjs";
import { sendMail } from "../mbs-mail.mjs";
import { invoiceStore, nextInvoiceNumber, makeFinalInvoicePdf, saveInvoice, libelleSeance } from "../mbs-invoice.mjs";

const FAIRE_PART_URL = "https://www.monfairepart.com/faire-part-naissance.html";
const AVIS_MBS_DEFAUT = "https://g.page/r/CTGWLnQvUCwtEBM/review";
const HEURE_SOIREE = 18;   // a partir de 18h a Paris, on souhaite une bonne soiree

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const REQUIRED = process.env.CRM_KEY || "";
const autorise = (request) => !REQUIRED || (request.headers.get("x-crm-key") || "") === REQUIRED;

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* Un lien de galerie arrive colle a la main : on refuse tout ce qui n'est pas
   une adresse http(s). Sans ca, un "javascript:" ou un "data:" partirait tel
   quel dans un email au nom de Matt. */
function lienValide(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch (e) { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  return u.href;
}

const prenomDe = (nom) => String(nom || "").trim().split(/\s+/)[0] || "";
const montant = (v) => { const n = parseFloat(String(v == null ? 0 : v).replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };

/* Journee ou soiree : l'heure de Paris, pas celle du serveur, qui tourne en
   UTC. Sans ca, tout ce qui part apres 20h en ete souhaiterait une bonne
   journee. */
function momentDuJour() {
  const h = Number(new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", hour12: false
  }).format(new Date()));
  return h >= HEURE_SOIREE ? "soirée" : "journée";
}

const bouton = (href, texte, fond) =>
  '<p style="margin:24px 0"><a href="' + esc(href) + '" style="background:' + fond +
  ';color:#FFFFFF;padding:14px 28px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold">' +
  esc(texte) + "</a></p>";

/* ---------------------------------------------------------------
   Le texte est ecrit par Matt dans le CRM, et modifiable a chaque envoi.
   Ici on ne fait que le mettre en forme.

   Tout ce qu'il tape est echappe : seuls les trois reperes entre crochets
   produisent du HTML. Rien de ce qui est saisi ne peut donc devenir une
   balise, un lien ou un script dans la boite du client.
   --------------------------------------------------------------- */
const JETONS = {
  "[bouton galerie]": (ctx) => bouton(ctx.galerie, ctx.libelleGalerie, ctx.couleur),
  "[bouton avis]":    (ctx) => ctx.avis ? bouton(ctx.avis, "Laisser un avis", "#6B6B6B") : "",
  "[code faire-part]": (ctx) => ctx.code
    ? '<p style="margin:14px 0"><span style="display:inline-block;border:2px dashed ' + ctx.couleur
      + ';border-radius:10px;padding:11px 22px;font-size:20px;font-weight:bold;letter-spacing:3px;color:#8A4B37">'
      + esc(ctx.code) + "</span></p>" + bouton(FAIRE_PART_URL, "Voir les faire-part", "#8A8078")
    : ""
};

function htmlDepuisTexte(texte, ctx) {
  const blocs = String(texte || "").replace(/\r\n/g, "\n").split(/\n[ \t]*\n/);
  let h = "";
  for (const b of blocs) {
    const t = b.trim();
    if (!t) continue;
    const jeton = JETONS[t.toLowerCase()];
    if (jeton) { h += jeton(ctx); continue; }
    h += "<p>" + esc(t).replace(/\n/g, "<br>") + "</p>";
  }
  return h;
}

/* ---------------------------------------------------------------
   La facture de solde.
   On cherche d'abord celle qui existe deja pour ce client : reemettre un
   numero pour une seance deja facturee creerait un doublon comptable. On
   n'en genere une que s'il n'y en a aucune.
   --------------------------------------------------------------- */
async function factureDeSolde(client, data) {
  const store = invoiceStore();
  const mail = String(client.email || "").toLowerCase();

  let idx = [];
  try { idx = (await store.get("index", { type: "json" })) || []; } catch (e) {}
  const deja = idx.find(e => e.kind === "solde" && String(e.email || "").toLowerCase() === mail);
  if (deja) {
    try {
      const pdf = await store.get("pdf-" + deja.number, { type: "arrayBuffer" });
      if (pdf) return { number: deja.number, pdf: Buffer.from(pdf), nouvelle: false };
    } catch (e) {}
  }

  const p = (data.paiements || [])
    .filter(x => x.clientId === client.id && x.brand === "mybabyshoot")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!p) return null;

  const total = montant(p.total);
  const acompte = montant(p.acompte);
  if (!total) return null;

  const s = (data.seances || [])
    .filter(x => x.clientId === client.id && x.brand === "mybabyshoot" && x.type !== "Indispo")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const typeLabel = (s && s.type) || "Séance";
  const seanceDateFr = s && s.date ? String(s.date).split("-").reverse().join("/") : "";

  const number = await nextInvoiceNumber();
  const dateStr = new Date().toLocaleDateString("fr-FR");
  const pdf = await makeFinalInvoicePdf({
    number, dateStr, client: { name: client.name, email: client.email },
    typeLabel, seanceDateFr, total, acompte
  });
  await saveInvoice({
    number, kind: "solde", pdf, client: { name: client.name, email: client.email },
    montant: Math.max(0, total - acompte), dateStr,
    detail: "Solde - " + libelleSeance(typeLabel) + (seanceDateFr ? " du " + seanceDateFr : "")
  });
  return { number, pdf, nouvelle: true };
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!autorise(request)) return json({ ok: false, error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const clientId = String(body.clientId || "").trim();
  if (!clientId) return json({ ok: false, error: "client" }, 400);

  /* Deux usages pour la meme fonction.

     factureSeule : la cliente vient de regler le solde au studio, Matt lui
     envoie sa facture tout de suite, sans attendre que la galerie soit
     prete. Pas de lien, pas de texte a relire, un seul geste.

     Sinon : le mail de fin de prestation, avec la galerie et la facture.

     Les deux passent par la MEME recherche de facture, et c'est tout
     l'interet : celle envoyee au studio sera retrouvee et rattachee au mail
     galerie, au lieu qu'un second numero soit emis pour la meme seance. */
  const factureSeule = !!body.factureSeule;
  const galerie = factureSeule ? "" : lienValide(body.galerie);
  const texte = factureSeule ? "" : String(body.texte || "").trim();

  if (!factureSeule) {
    if (!galerie) return json({ ok: false, error: "galerie" }, 400);
    // Le texte vient toujours du CRM : c'est la seule version, celle que Matt
    // a sous les yeux. Pas de repli silencieux ici, qui enverrait autre chose
    // que ce qu'il a relu.
    if (!texte) return json({ ok: false, error: "sans_texte" }, 400);
  }

  let data;
  try { data = await loadData(crmStore()); }
  catch (e) { return json({ ok: false, error: "indisponible" }, 503); }

  const client = (data.clients || []).find(c => c.id === clientId);
  if (!client) return json({ ok: false, error: "introuvable" }, 404);
  if (!client.email) return json({ ok: false, error: "sans_email" }, 400);

  const reglages = data.reglages || {};
  const mariage = client.brand === "maison-lumiere";
  if (factureSeule && mariage) {
    return json({ ok: false, error: "marque",
      message: "Les factures ne sont émises que pour Mybabyshoot." }, 400);
  }

  // Facture de solde : uniquement Mybabyshoot, la seule marque facturee ici.
  let facture = null;
  if (!mariage) {
    try { facture = await factureDeSolde(client, data); } catch (e) { facture = null; }
    if (!facture) return json({ ok: false, error: "sans_facture" }, 400);
  }

  /* La facture seule : un mail court, sans lien ni bouton. Elle part alors
     que la cliente est encore au studio ou vient d'en sortir, le contexte
     est frais, il n'y a rien a expliquer. */
  if (factureSeule) {
    const html =
      "<p>Bonjour " + esc(prenomDe(client.name)) + " !</p>" +
      "<p>Merci pour votre confiance et pour ce moment passé ensemble.</p>" +
      "<p>Vous trouverez votre facture en pièce jointe, solde réglé.</p>" +
      "<p>Vos photos arrivent, je vous envoie la galerie dès qu'elle est prête.</p>" +
      "<p>Très belle " + momentDuJour() + " à vous<br>Matt</p>";
    const parti = await sendMail({
      to: client.email,
      subject: "Votre facture · Mybabyshoot",
      html,
      attachments: [{ filename: "Facture-" + facture.number + ".pdf",
        content: facture.pdf, contentType: "application/pdf" }]
    });
    if (!parti) return json({ ok: false, error: "envoi" }, 502);
    return json({ ok: true, destinataire: client.email,
      facture: facture.number, factureCreee: !!facture.nouvelle });
  }

  const html = htmlDepuisTexte(texte, {
    galerie,
    libelleGalerie: mariage ? "Voir mes photos" : "Découvrir ma galerie",
    couleur: mariage ? "#5E4430" : "#C97B63",
    avis: mariage ? lienValide(reglages.avisLumiere)
                  : (lienValide(reglages.avisMybabyshoot) || AVIS_MBS_DEFAUT),
    code: mariage ? "" : String(reglages.codeFairePart || "").trim().slice(0, 24)
  });
  const sujet = mariage ? "Vos photos de mariage sont en ligne" : "Vos photos sont en ligne";

  const envoye = await sendMail({
    to: client.email,
    subject: sujet,
    html,
    attachments: facture
      ? [{ filename: "Facture-" + facture.number + ".pdf", content: facture.pdf, contentType: "application/pdf" }]
      : []
  });

  if (!envoye) return json({ ok: false, error: "envoi" }, 502);
  return json({
    ok: true,
    destinataire: client.email,
    facture: facture ? facture.number : "",
    factureCreee: !!(facture && facture.nouvelle)
  });
};

export const config = { path: "/.netlify/functions/crm-mail-final" };
