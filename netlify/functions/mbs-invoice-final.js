// netlify/functions/mbs-invoice-final.js
// Genere et envoie la FACTURE DE SOLDE (finale) d'une reservation, declenchee
// depuis le CRM quand le client a regle le solde. Protege par CRM_KEY (comme
// store-crm) : seul le CRM authentifie peut l'appeler.
import { nextInvoiceNumber, makeFinalInvoicePdf, sendInvoiceMail } from "../mbs-invoice.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

function authorized(request){
  const required = process.env.CRM_KEY || "";
  if (!required) return true; // pas encore configure : ouvert
  return (request.headers.get("x-crm-key") || "") === required;
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  const client = body.client || {};
  const email = String(client.email || "").trim();
  if (!email) return json({ ok: false, error: "no_email" }, 400);

  const total = Number(body.total) || 0;
  const acompte = Number(body.acompte) || 0;
  const solde = Math.max(0, total - acompte);
  const typeLabel = String(body.typeLabel || "photo");
  const seanceDateFr = String(body.seanceDateFr || "");

  try {
    const number = await nextInvoiceNumber();
    const dateStr = new Date().toLocaleDateString("fr-FR");
    const pdf = await makeFinalInvoicePdf({
      number, dateStr, client: { name: client.name, email },
      typeLabel, seanceDateFr, total, acompte
    });
    const html =
      "<p>Bonjour " + (client.name || "") + ",</p>" +
      "<p>Merci pour votre confiance. Vous trouverez votre facture (solde regle) en piece jointe.</p>" +
      "<ul>" +
      "<li><b>Seance :</b> " + typeLabel + (seanceDateFr ? " du " + seanceDateFr : "") + "</li>" +
      "<li><b>Total :</b> " + total + " euros</li>" +
      "<li><b>Acompte deja verse :</b> " + acompte + " euros</li>" +
      "<li><b>Solde regle :</b> " + solde + " euros</li>" +
      "</ul>" +
      "<p>A tres vite,<br>Mybabyshoot</p>";
    const sent = await sendInvoiceMail({
      to: email, subject: "Votre facture . Mybabyshoot",
      html, pdf, pdfName: "Facture-" + number + ".pdf"
    });
    return json({ ok: true, number, sent });
  } catch (e) {
    return json({ ok: false, error: "invoice_failed", detail: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/.netlify/functions/mbs-invoice-final" };
