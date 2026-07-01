// netlify/functions/crm-call.js
// Recoit une demande d'appel depuis le site Maison Lumiere (prise de RDV)
// et l'ajoute au CRM : un prospect maison-lumiere + un RDV telephonique dans l'agenda.
// A deployer sur LE MEME site Netlify que store-crm.js.
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function frDate(iso){
  if(!iso) return "";
  const p=(""+iso).split("-");
  if(p.length!==3) return iso;
  return p[2]+"/"+p[1]+"/"+p[0];
}
function rid(now){ return now.toString(36) + Math.random().toString(36).slice(2, 7); }

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
  const objet     = (lead.objet || "").trim();
  const mariage   = (lead.dateMariage || lead.eventDate || lead.date_mariage || "").trim();
  const lieu      = (lead.lieu || "").trim();
  const message   = (lead.message || lead.notes || "").trim();
  const creneau   = (lead.creneau || "").trim();
  const callDate  = (lead.callDate || "").trim();   // AAAA-MM-JJ
  const callTime  = (lead.callTime || "").trim();   // HH:MM

  const now = Date.now();
  const stamp = new Date(now).toLocaleDateString("fr-FR");

  const noteLine = "Demande d'appel du " + stamp
    + (creneau ? " | creneau : " + creneau : "")
    + (objet ? " | objet : " + objet : "")
    + (mariage ? " | mariage le " + frDate(mariage) : "")
    + (lieu ? " | lieu : " + lieu : "")
    + (message ? " | " + message : "");

  // prospect existant (meme email ou meme telephone) ou nouvelle fiche
  let client = data.clients.find(c =>
    c.brand === "maison-lumiere" &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g,"") === tel.replace(/\s/g,"")))
  );

  if (client) {
    client.notes = (client.notes ? client.notes + "\n" : "") + noteLine;
    client.tel       = client.tel       || tel;
    client.email     = client.email     || email;
    client.eventDate = client.eventDate || mariage;
    client.fromSite  = true;
    if (!client.createdAt) client.createdAt = now;
  } else {
    client = {
      id: rid(now),
      brand: "maison-lumiere",
      name: nom,
      status: "Prospect",
      type: "Mariage",
      tel, email, insta: "",
      budget: "",
      source: "RDV telephonique site Maison Lumiere",
      notes: noteLine,
      eventDate: mariage,
      fromSite: true,
      createdAt: now
    };
    data.clients.push(client);
  }

  // creation du RDV telephonique (seance dediee)
  data.seances.push({
    id: rid(now + 1),
    clientId: client.id,
    brand: "maison-lumiere",
    type: "RDV telephonique",
    date: callDate || mariage || new Date(now).toISOString().slice(0,10),
    time: callTime || "",
    place: "Appel",
    status: "A venir",
    objet: objet,
    creneau: creneau,
    notes: [objet ? "Objet : " + objet : "", message].filter(Boolean).join("\n"),
    fromSite: true,
    createdAt: now
  });

  data.t = now;
  await store.setJSON(KEY, data);

  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
};

export const config = { path: "/.netlify/functions/crm-call" };
