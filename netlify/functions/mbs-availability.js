// netlify/functions/mbs-availability.js
// Renvoie les creneaux disponibles pour la reservation Mybabyshoot.
// Lecture seule. Appele en cross-origin depuis le site mybabyshoot.
import { crmStore, loadData, computeAvailability, SLOTS, OPEN_DAYS } from "../mbs-lib.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET")
    return new Response("Methode non supportee", { status: 405, headers: cors });

  try {
    const store = crmStore();
    const data = await loadData(store);
    const days = computeAvailability(data);
    return new Response(JSON.stringify({
      ok: true,
      slots: SLOTS,
      openDays: OPEN_DAYS,
      days,
      generatedAt: Date.now()
    }), {
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/.netlify/functions/mbs-availability" };
