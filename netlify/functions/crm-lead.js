// netlify/functions/crm-lead.js
// Recoit un lead depuis le site Maison Lumiere (formulaire de devis)
// et l'ajoute au CRM en Prospect maison-lumiere.
// Regroupement : si le meme email OU le meme telephone existe deja,
// on garde la fiche et on ajoute la nouvelle demande dans ses notes (rien de perdu).
// A deployer sur LE MEME site Netlify que store-crm.js (memes donnees).
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function frDate(iso){
  if(!iso) return "";
  const p = (""+iso).split("-");
  if(p.length!==3) return iso;
  return p[2]+"/"+p[1]+"/"+p[0];
}

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
  const stamp = new Date(now).toLocaleDateString("fr-FR");

  // ligne d'historique pour ce devis (datee, avec date de mariage + details)
  const devisLine = "Devis du " + stamp
    + (eventDate ? " | mariage le " + frDate(eventDate) : "")
    + (message ? " | " + message : "");

  // fiche existante avec le meme email OU le meme telephone (marque maison-lumiere)
  const dup = data.clients.find(c =>
    c.brand === "maison-lumiere" &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g,"") === tel.replace(/\s/g,"")))
  );

  if (dup) {
    // on regroupe : on garde la fiche, on empile la nouvelle demande dans les notes
    dup.notes = (dup.notes ? dup.notes + "\n" : "") + devisLine;
    // on complete les infos manquantes sans ecraser ce qui existe
    dup.tel       = dup.tel       || tel;
    dup.email     = dup.email     || email;
    dup.eventDate = dup.eventDate || eventDate;
    dup.budget    = dup.budget    || budget;
    dup.devisCount = (Number(dup.devisCount) || 1) + 1;
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
      notes: devisLine,
      eventDate,
      fromSite: true,
      devisCount: 1,
      createdAt: now
    });
  }

  data.t = now;
  await store.setJSON(KEY, data);

  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
};

export const config = { path: "/.netlify/functions/crm-lead" };
