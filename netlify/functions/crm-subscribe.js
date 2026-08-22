// netlify/functions/crm-subscribe.js
// Enregistre (ou retire) l'abonnement d'un appareil aux notifications push.
// Protege par le mot de passe du CRM (CRM_KEY).
import { getStore } from "@netlify/blobs";

const REQUIRED = process.env.CRM_KEY || "";
function authorized(request){
  if(!REQUIRED) return true;
  return (request.headers.get("x-crm-key") || "") === REQUIRED;
}
function keyFor(sub){
  const ep = (sub && sub.endpoint) || "";
  let h = 0; for(let i=0;i<ep.length;i++){ h = (h*31 + ep.charCodeAt(i)) >>> 0; }
  return "sub_" + h.toString(36);
}

export default async (request) => {
  if(!authorized(request)){
    return new Response(JSON.stringify({ ok:false, error:"unauthorized" }), { status:401, headers:{ "Content-Type":"application/json" } });
  }
  const store = getStore({ name: "studio-crm-push" });
  let sub;
  try { sub = await request.json(); } catch(e){ return new Response(JSON.stringify({ ok:false }), { status:400 }); }
  if(!sub || !sub.endpoint) return new Response(JSON.stringify({ ok:false, error:"no endpoint" }), { status:400 });

  if(request.method === "DELETE"){
    await store.delete(keyFor(sub));
    return new Response(JSON.stringify({ ok:true }), { headers:{ "Content-Type":"application/json" } });
  }
  // POST : enregistrer
  await store.setJSON(keyFor(sub), sub);
  return new Response(JSON.stringify({ ok:true }), { headers:{ "Content-Type":"application/json" } });
};

export const config = { path: "/.netlify/functions/crm-subscribe" };
