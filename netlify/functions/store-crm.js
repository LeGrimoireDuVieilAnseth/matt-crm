// netlify/functions/store-crm.js
// Coffre de synchronisation du CRM Studio (separe du Grimoire).
// Protege par mot de passe : la lecture et l'ecriture exigent la bonne cle
// (definie dans la variable d'environnement Netlify CRM_KEY).
// Tant que CRM_KEY n'est pas definie, l'acces reste ouvert (phase de mise en place).
import { getStore } from "@netlify/blobs";

const REQUIRED = process.env.CRM_KEY || "";

function authorized(request){
  if(!REQUIRED) return true; // pas encore configure
  const k = request.headers.get("x-crm-key") || "";
  return k === REQUIRED;
}

export default async (request) => {
  const store = getStore({ name: "studio-crm", consistency: "strong" });
  const KEY = "data";

  if (!authorized(request)) {
    return new Response(JSON.stringify({ ok:false, error:"unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

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
