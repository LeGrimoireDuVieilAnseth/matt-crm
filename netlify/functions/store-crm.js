// netlify/functions/store-crm.js
// Coffre de synchronisation du CRM Studio (separe du Grimoire).
// GET  : renvoie les donnees enregistrees (lecture forte, toujours a jour)
// PUT  : enregistre les donnees envoyees par l'app
import { getStore } from "@netlify/blobs";

export default async (request) => {
  const store = getStore({ name: "studio-crm", consistency: "strong" });
  const KEY = "data";

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
