// netlify/functions/crm-subscribe.js
// Enregistre (ou retire) l'abonnement d'un appareil aux notifications push.
// Protege par le mot de passe du CRM (CRM_KEY).
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
function keyFor(sub){
  const ep = (sub && sub.endpoint) || "";
  let h = 0; for(let i=0;i<ep.length;i++){ h = (h*31 + ep.charCodeAt(i)) >>> 0; }
  return "sub_" + h.toString(36);
}

export default async (request) => {
  const refus = await refusCle(request);
  if (refus) return refus;
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
