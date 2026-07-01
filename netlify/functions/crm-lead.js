// netlify/functions/crm-lead.js
// Recoit un lead depuis le site Maison Lumiere (formulaire de devis)
// et l'ajoute automatiquement au CRM en Prospect maison-lumiere.
// A deployer sur LE MEME site Netlify que store-crm.js (memes donnees).
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default async (request) => {
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (request.method !== "POST")
    return new Response("Methode non supportee", { status: 405, headers: cors });

  let lead;
  try { lead = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok:false, error:"json" }), { status:400, headers:{...cors,"Content-Type":"application/json"} }); }

  const store = getStore({ name: "studio-crm", consistency: "strong" });
  const KEY = "data";
  const data = (await store.get(KEY, { type: "json", consistency: "strong" })) || {};
  data.clients   = data.clients   || [];
  data.seances   = data.seances   || [];
  data.paiements = data.paiements || [];
  data.taches    = data.taches    || [];

  const nom       = [lead.prenom, lead.nom].filter(Boolean).join(" ").trim() || lead.name || lead.nomComplet || "Prospect";
  const tel       = (lead.tel || lead.telephone || lead.phone || "").trim();
  const email     = (lead.email || lead.mail || "").trim();
  const eventDate = (lead.eventDate || lead.dateEvenement || lead.dateMariage || lead.date || "").trim();
  const budget    = (lead.budget || "").toString().trim();
  const message   = (lead.message || lead.notes || "").trim();

  const now = Date.now();
  const dup = data.clients.find(c =>
    c.brand === "maison-lumiere" &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) || (tel && c.tel && c.tel.replace(/\s/g,"") === tel.replace(/\s/g,"")))
  );

  if (dup) {
    dup.tel       = dup.tel       || tel;
    dup.email     = dup.email     || email;
    dup.eventDate = dup.eventDate || eventDate;
    dup.budget    = dup.budget    || budget;
    dup.notes     = (dup.notes ? dup.notes + "\n" : "") + "Nouveau devis telecharge le " + new Date(now).toLocaleDateString("fr-FR") + (message ? " : " + message : "");
    dup.fromSite  = true;
    if (!dup.createdAt) dup.createdAt = now;
  } else {
    data.clients.push({
      id: now.toString(36) + Math.random().toString(36).slice(2, 7),
      brand: "maison-lumiere",
      name: nom,
      status: "Prospect",
      type: lead.type || "Mariage",
      tel, email, insta: "",
      budget,
      source: "Devis site Maison Lumiere",
      notes: message,
      eventDate,
      fromSite: true,
      createdAt: now
    });
  }

  data.t = now;
  await store.setJSON(KEY, data);

  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
};

export const config = { path: "/.netlify/functions/crm-lead" };
