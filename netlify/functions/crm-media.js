// netlify/functions/crm-media.js
// Stockage des photos d'inspiration liees aux clients (separe des donnees texte).
// Protege par le meme mot de passe que le CRM (variable CRM_KEY).
// PUT  ?id=CLE   : enregistre l'image (corps binaire)
// GET  ?id=CLE   : renvoie l'image
// DELETE ?id=CLE : supprime l'image
import { getStore } from "@netlify/blobs";
import { cleCRM, statutRefus, MESSAGE_TROP_CRM } from "../mbs-garde.mjs";

/* Le controle de la cle vit dans mbs-garde.mjs : il refuse tout si CRM_KEY
   manque, et bloque une adresse apres trop d'essais rates. Renvoie la
   reponse de refus, ou null si la cle est bonne. */
const refusCle = async (request) => {
  const etat = await cleCRM(request);
  if (etat === "ok") return null;
  return new Response(JSON.stringify(etat === "bloque"
    ? { ok: false, error: "trop", message: MESSAGE_TROP_CRM }
    : { ok: false, error: "unauthorized" }),
    { status: statutRefus(etat), headers: { "Content-Type": "application/json" } });
};

export default async (request) => {
  const refus = await refusCle(request);
  if (refus) return refus;
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const store = getStore({ name: "studio-crm-media", consistency: "strong" });

  if(request.method === "PUT"){
    if(!id) return new Response("no id", { status:400 });
    const buf = await request.arrayBuffer();
    const type = request.headers.get("content-type") || "image/jpeg";
    await store.set(id, buf, { metadata:{ type } });
    return new Response(JSON.stringify({ ok:true }), { headers:{ "Content-Type":"application/json" } });
  }

  if(request.method === "GET"){
    if(!id) return new Response("no id", { status:400 });
    try{
      const res = await store.getWithMetadata(id, { type:"arrayBuffer" });
      if(!res || !res.data) return new Response("not found", { status:404 });
      const type = (res.metadata && res.metadata.type) || "image/jpeg";
      return new Response(res.data, { headers:{ "Content-Type":type, "Cache-Control":"private, max-age=86400" } });
    }catch(e){ return new Response("not found", { status:404 }); }
  }

  if(request.method === "DELETE"){
    if(id){ try{ await store.delete(id); }catch(e){} }
    return new Response(JSON.stringify({ ok:true }), { headers:{ "Content-Type":"application/json" } });
  }

  return new Response("Methode non supportee", { status:405 });
};

export const config = { path: "/.netlify/functions/crm-media" };
