// netlify/functions/mlp-demande.js
// Les demandes de devis du site Matt la Photo (24/10/2026) : une marque
// pour une collaboration, une soiree ou un evenement prive. Tout cela se
// fait sur devis (choix de Matt) : la demande devient une fiche "Prospect"
// de la marque matt-la-photo dans le CRM (onglet Demandes), et Matt est
// prevenu sur son telephone. Comme mbs-lead pour Mybabyshoot : une fiche
// deja connue (meme mail ou meme telephone) est completee, pas dupliquee.
//
// PUBLIC, adresse neutre /demande-api. Garde-fous : un champ piege que les
// humains ne voient pas, et 10 demandes par heure et par adresse.
import { getStore } from "@netlify/blobs";
import { notifyAll } from "../push-lib.mjs";
import { porteFermee, noterEchec, LIMITE_CODES } from "../mbs-garde.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const TYPES = { collaboration: "Collaboration", evenement: "Événement privé", shooting: "Shooting" };
const propre = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false }, 405);
  if (await porteFermee("mlp-demande", request, LIMITE_CODES))
    return json({ ok: false, erreur: "trop", message: "Trop de demandes envoyées. Réessayez dans une heure, ou appelez le 06 47 76 54 17." }, 429);

  let d = {};
  try { d = await request.json(); } catch (e) { return json({ ok: false, erreur: "json" }, 400); }
  /* Le champ piege : invisible pour un humain, rempli par les robots. On
     repond "ok" pour ne pas leur apprendre la parade. */
  if (propre(d.site, 200)) return json({ ok: true });
  await noterEchec("mlp-demande", request, LIMITE_CODES);

  const type = TYPES[d.type] ? d.type : "collaboration";
  const prenom = propre(d.prenom, 60), nom = propre(d.nom, 60);
  const email = propre(d.email, 160).toLowerCase(), tel = propre(d.tel, 30);
  const entreprise = propre(d.entreprise, 120), date = propre(d.date, 60), lieu = propre(d.lieu, 120);
  const budget = propre(d.budget, 60), invites = propre(d.invites, 40);
  const message = String(d.message || "").trim().slice(0, 2000);
  if (!prenom && !nom && !entreprise) return json({ ok: false, erreur: "nom" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && tel.replace(/\D/g, "").length < 9) return json({ ok: false, erreur: "contact" }, 400);

  const now = Date.now();
  const qui = [prenom, nom].filter(Boolean).join(" ") || entreprise;
  const detail = [
    "Demande de devis du " + new Date(now).toLocaleDateString("fr-FR") + " · " + TYPES[type],
    entreprise && "Marque / entreprise : " + entreprise,
    date && "Date : " + date, lieu && "Lieu : " + lieu, invites && "Invités : " + invites, budget && "Budget : " + budget,
    message && "Message : " + message
  ].filter(Boolean).join("\n");

  const store = getStore({ name: "studio-crm", consistency: "strong" });
  const data = (await store.get("data", { type: "json", consistency: "strong" })) || {};
  data.clients = data.clients || []; data.seances = data.seances || [];
  data.paiements = data.paiements || []; data.taches = data.taches || [];

  const dup = data.clients.find(c => c.brand === "matt-la-photo" &&
    ((email && c.email && c.email.toLowerCase() === email) ||
     (tel && c.tel && c.tel.replace(/\s/g, "") === tel.replace(/\s/g, ""))));
  if (dup) {
    dup.notes = (dup.notes ? dup.notes + "\n\n" : "") + detail;
    dup.tel = dup.tel || tel; dup.email = dup.email || email;
    dup.fromSite = true;
    if (!dup.createdAt) dup.createdAt = now;
  } else {
    data.clients.push({
      id: now.toString(36) + Math.random().toString(36).slice(2, 7),
      brand: "matt-la-photo", name: qui, status: "Prospect", type: TYPES[type],
      tel, email, insta: "", source: "Demande de devis, site Matt la Photo",
      notes: detail, fromSite: true, createdAt: now
    });
  }
  data.t = now;
  await store.setJSON("data", data);

  try { await notifyAll("Demande de devis · Matt la Photo", qui + " · " + TYPES[type] + (tel ? " · " + tel : ""), "/"); } catch (e) {}
  return json({ ok: true });
};

export const config = { path: ["/.netlify/functions/mlp-demande", "/demande-api"] };
