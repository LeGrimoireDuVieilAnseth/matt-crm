// netlify/functions/mbs-lead.js
// Recoit une demande de contact depuis le site Mybabyshoot et cree un
// client "Prospect" brand "mybabyshoot" dans le CRM (memes donnees que
// store-crm). Regroupe par email OU telephone pour ne rien dupliquer.
import { getStore } from "@netlify/blobs";
import { notifyAll } from "../push-lib.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
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

  const nom     = [lead.prenom, lead.nom].filter(Boolean).join(" ").trim() || "Prospect";
  const tel     = (lead.tel || "").trim();
  const email   = (lead.email || "").trim();
  const typeDem = (lead.type || "").trim();
  const message = (lead.message || "").trim();

  const now = Date.now();
  const stamp = new Date(now).toLocaleDateString("fr-FR");
  const ligne = "Demande du " + stamp + (typeDem ? " | " + typeDem : "") + (message ? " | " + message : "");

  // fiche existante avec le meme email OU le meme telephone (marque mybabyshoot)
  const dup = data.clients.find(c =>
    c.brand === "mybabyshoot" &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g,"") === tel.replace(/\s/g,"")))
  );

  if (dup) {
    dup.notes = (dup.notes ? dup.notes + "\n" : "") + ligne;
    dup.tel   = dup.tel   || tel;
    dup.email = dup.email || email;
    if (!dup.createdAt) dup.createdAt = now;
    dup.fromSite = true;
  } else {
    data.clients.push({
      id: now.toString(36) + Math.random().toString(36).slice(2, 7),
      brand: "mybabyshoot",
      name: nom,
      status: "Prospect",
      type: typeDem || "Seance",
      tel, email, insta: "",
      source: "Contact site Mybabyshoot",
      notes: ligne,
      fromSite: true,
      createdAt: now
    });
  }

  data.t = now;
  await store.setJSON(KEY, data);

  try {
    await notifyAll(
      "Nouveau contact Mybabyshoot",
      nom + (typeDem ? " . " + typeDem : "") + (tel ? " . " + tel : ""),
      "/"
    );
  } catch (e) {}

  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
};

export const config = { path: "/.netlify/functions/mbs-lead" };
