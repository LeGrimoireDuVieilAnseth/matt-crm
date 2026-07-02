// netlify/functions/crm-media.js
// Stockage des photos d'inspiration liees aux clients (separe des donnees texte).
// Protege par le meme mot de passe que le CRM (variable CRM_KEY).
// PUT  ?id=CLE   : enregistre l'image (corps binaire)
// GET  ?id=CLE   : renvoie l'image
// DELETE ?id=CLE : supprime l'image
import { getStore } from "@netlify/blobs";

const REQUIRED = process.env.CRM_KEY || "";
function authorized(request){
  if(!REQUIRED) return true;
  return (request.headers.get("x-crm-key") || "") === REQUIRED;
}

export default async (request) => {
  if(!authorized(request)){
    return new Response(JSON.stringify({ ok:false, error:"unauthorized" }), { status:401, headers:{ "Content-Type":"application/json" } });
  }
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
