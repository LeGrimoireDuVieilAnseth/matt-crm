// netlify/functions/crm-mail-final.js
// Le mail de fin de prestation, declenche a la main depuis la fiche client.
//
// POST (protege par CRM_KEY) : { clientId, galerie } -> envoie le mail
//
// Le destinataire n'est jamais fourni par l'appelant : on le lit dans la
// fiche a partir de son identifiant. Meme avec la cle, cette fonction ne
// peut donc ecrire qu'a quelqu'un qui est deja client de Matt, et jamais
// servir a envoyer un message a une adresse quelconque.
//
// Elle ne modifie rien dans les donnees : c'est le CRM qui note l'envoi sur
// la fiche. Un seul ecrivain sur le blob, pas de course entre les deux.
import { crmStore, loadData } from "../mbs-lib.mjs";
import { sendMail } from "../mbs-mail.mjs";

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

const bouton = (href, texte, fond) =>
  '<p style="margin:26px 0"><a href="' + esc(href) + '" style="background:' + fond +
  ';color:#FFF;padding:14px 28px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold">' +
  esc(texte) + "</a></p>";

/* Deux marques, deux voix. Le lien d'avis est facultatif : tant qu'il n'est
   pas renseigne dans les reglages, le paragraphe entier disparait plutot que
   d'envoyer un bouton qui ne mene nulle part. */
function corpsDuMail(marque, prenom, galerie, avis) {
  const mariage = marque === "maison-lumiere";
  const couleur = mariage ? "#5E4430" : "#C97B63";
  const signature = mariage ? "Matteo · Maison Lumière" : "Matteo · Mybabyshoot";

  let html = "<p>Bonjour " + esc(prenom) + ",</p>";

  if (mariage) {
    html += "<p>Vos photos de mariage sont prêtes. J'ai pris le temps qu'il fallait, "
      + "et j'ai hâte que vous les découvriez.</p>";
  } else {
    html += "<p>Vos photos sont prêtes. Merci encore pour ce moment passé ensemble.</p>";
  }

  html += bouton(galerie, "Voir mes photos", couleur);
  html += "<p>Prenez le temps de les télécharger et d'en garder une copie de votre côté : "
    + "c'est le meilleur moyen de ne jamais les perdre.</p>";

  if (avis) {
    html += "<p style=\"margin-top:26px\">Si le résultat vous plaît, quelques mots en avis "
      + "m'aideraient beaucoup. C'est ce qui permet à d'autres familles de me trouver, "
      + "et ça ne prend qu'une minute.</p>";
    html += bouton(avis, "Laisser un avis", "#6B6B6B");
  }

  html += "<p style=\"margin-top:26px\">Une question, une envie de tirage ou d'album ? "
    + "Répondez simplement à cet email.</p>";
  html += "<p>À très vite<br>" + esc(signature) + "</p>";
  return html;
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
  const avis = lienValide(client.brand === "maison-lumiere"
    ? reglages.avisLumiere : reglages.avisMybabyshoot);

  const sujet = client.brand === "maison-lumiere"
    ? "Vos photos de mariage sont en ligne"
    : "Vos photos sont en ligne";

  const envoye = await sendMail({
    to: client.email,
    subject: sujet,
    html: corpsDuMail(client.brand, prenomDe(client.name), galerie, avis)
  });

  if (!envoye) return json({ ok: false, error: "envoi" }, 502);
  return json({ ok: true, destinataire: client.email, avisInclus: !!avis });
};

export const config = { path: "/.netlify/functions/crm-mail-final" };
