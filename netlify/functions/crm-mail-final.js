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
import { invoiceStore, nextInvoiceNumber, makeFinalInvoicePdf, saveInvoice } from "../mbs-invoice.mjs";

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
   Le mail Mybabyshoot, texte de Matt.
   --------------------------------------------------------------- */
function mailMybabyshoot(prenom, galerie, avis, code, avecFacture) {
  let h = "<p>Bonjour " + esc(prenom) + " !</p>";
  h += "<p>C'était un plaisir de réaliser votre séance ! Encore merci pour votre confiance !</p>";
  h += "<p>Vous pouvez découvrir et sélectionner vos photos en cliquant sur le bouton juste en dessous.</p>";
  h += "<p>Pour sélectionner les photos que vous souhaitez que je retouche, c'est très simple : "
     + "il suffit de les liker.</p>";
  h += "<p>Vous pourrez aussi faire imprimer des photos directement depuis la galerie. "
     + "Il y a plusieurs types d'impressions et de tailles.</p>";
  h += bouton(galerie, "Découvrir ma galerie", "#C97B63");

  if (code) {
    h += "<p>Voici votre code promo pour obtenir <b>-20 % sur vos faire-part</b> sur monfairepart.com :</p>";
    h += '<p style="margin:14px 0"><span style="display:inline-block;border:2px dashed #C97B63;border-radius:10px;'
       + 'padding:11px 22px;font-size:20px;font-weight:bold;letter-spacing:3px;color:#8A4B37">'
       + esc(code) + "</span></p>";
    h += bouton(FAIRE_PART_URL, "Voir les faire-part", "#8A8078");
  }

  if (avis) {
    h += "<p>Si la séance et ce premier résultat vous ont plu, quelques mots en avis m'aideraient beaucoup. "
       + "C'est ce qui permet à d'autres familles de me trouver plus facilement, et ça ne prend qu'une minute.</p>";
    h += bouton(avis, "Laisser un avis", "#6B6B6B");
  }

  if (avecFacture) {
    h += '<p style="font-size:13px;color:#888">Votre facture, solde réglé, est en pièce jointe.</p>';
  }

  h += "<p>Très belle " + momentDuJour() + " à vous<br>Matt</p>";
  return h;
}

/* ---------------------------------------------------------------
   Le mail Maison Lumiere, inchange pour l'instant.
   --------------------------------------------------------------- */
function mailMaisonLumiere(prenom, galerie, avis) {
  let h = "<p>Bonjour " + esc(prenom) + ",</p>";
  h += "<p>Vos photos de mariage sont prêtes. J'ai pris le temps qu'il fallait, "
     + "et j'ai hâte que vous les découvriez.</p>";
  h += bouton(galerie, "Voir mes photos", "#5E4430");
  h += "<p>Prenez le temps de les télécharger et d'en garder une copie de votre côté : "
     + "c'est le meilleur moyen de ne jamais les perdre.</p>";
  if (avis) {
    h += "<p>Si le résultat vous plaît, quelques mots en avis m'aideraient beaucoup. "
       + "C'est ce qui permet à d'autres couples de me trouver, et ça ne prend qu'une minute.</p>";
    h += bouton(avis, "Laisser un avis", "#6B6B6B");
  }
  h += "<p>Une question, une envie de tirage ou d'album ? Répondez simplement à cet email.</p>";
  h += "<p>À très vite<br>Matteo · Maison Lumière</p>";
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
    detail: "Solde " + typeLabel + (seanceDateFr ? " du " + seanceDateFr : "")
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
  const galerie = lienValide(body.galerie);
  if (!clientId) return json({ ok: false, error: "client" }, 400);
  if (!galerie) return json({ ok: false, error: "galerie" }, 400);

  let data;
  try { data = await loadData(crmStore()); }
  catch (e) { return json({ ok: false, error: "indisponible" }, 503); }

  const client = (data.clients || []).find(c => c.id === clientId);
  if (!client) return json({ ok: false, error: "introuvable" }, 404);
  if (!client.email) return json({ ok: false, error: "sans_email" }, 400);

  const reglages = data.reglages || {};
  const mariage = client.brand === "maison-lumiere";

  // Facture de solde : uniquement Mybabyshoot, la seule marque facturee ici.
  let facture = null;
  if (!mariage) {
    try { facture = await factureDeSolde(client, data); } catch (e) { facture = null; }
    if (!facture) return json({ ok: false, error: "sans_facture" }, 400);
  }

  let html, sujet;
  if (mariage) {
    html = mailMaisonLumiere(prenomDe(client.name), galerie, lienValide(reglages.avisLumiere));
    sujet = "Vos photos de mariage sont en ligne";
  } else {
    const avis = lienValide(reglages.avisMybabyshoot) || AVIS_MBS_DEFAUT;
    const code = String(reglages.codeFairePart || "").trim().slice(0, 24);
    html = mailMybabyshoot(prenomDe(client.name), galerie, avis, code, true);
    sujet = "Vos photos sont en ligne";
  }

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
