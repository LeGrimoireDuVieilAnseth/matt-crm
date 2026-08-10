// netlify/functions/mbs-factures.js
// Archive des factures Mybabyshoot (protege par CRM_KEY).
// - GET ?list=1        : index de toutes les factures archivees
// - GET ?pdf=NUMERO    : le PDF de la facture demandee
import { invoiceStore } from "../mbs-invoice.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const REQUIRED = process.env.CRM_KEY || "";
const authorized = (request) =>
  !REQUIRED ||
  (request.headers.get("x-crm-key") || "") === REQUIRED ||
  new URL(request.url).searchParams.get("key") === REQUIRED;

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);
  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);

  const url = new URL(request.url);
  const store = invoiceStore();

  if (url.searchParams.get("list")) {
    let index = [];
    try { index = (await store.get("index", { type: "json" })) || []; } catch (e) {}
    const total = index.reduce((s, f) => s + (Number(f.montant) || 0), 0);
    return json({ ok: true, total, nombre: index.length, factures: index });
  }

  // un numero de facture ne contient que des lettres, chiffres et tirets
  const num = (url.searchParams.get("pdf") || "").replace(/[^A-Za-z0-9-]/g, "");
  if (!num) return json({ ok: false, error: "numero" }, 400);

  let pdf = null;
  try { pdf = await store.get("pdf-" + num, { type: "arrayBuffer" }); } catch (e) {}
  if (!pdf) return json({ ok: false, error: "introuvable" }, 404);

  return new Response(pdf, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="Facture-' + num + '.pdf"',
      "Cache-Control": "no-store"
    }
  });
};

export const config = { path: "/.netlify/functions/mbs-factures" };
