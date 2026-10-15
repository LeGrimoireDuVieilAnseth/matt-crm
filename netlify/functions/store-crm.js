// netlify/functions/store-crm.js
// Coffre de synchronisation du CRM Studio (separe du Grimoire).
// Protege par mot de passe : la lecture et l'ecriture exigent la bonne cle
// (definie dans la variable d'environnement Netlify CRM_KEY).
// Tant que CRM_KEY n'est pas definie, l'acces reste ouvert (phase de mise en place).
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
  const store = getStore({ name: "studio-crm", consistency: "strong" });
  const KEY = "data";

  const refus = await refusCle(request);
  if (refus) return refus;

  if (request.method === "GET") {
    const data = await store.get(KEY, { type: "json", consistency: "strong" });
    return new Response(JSON.stringify(data || {}), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  if (request.method === "PUT") {
    try {
      const body = await request.json();
      await store.setJSON(KEY, body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 400 });
    }
  }

  return new Response("Methode non supportee", { status: 405 });
};

export const config = { path: "/.netlify/functions/store-crm" };
