// netlify/mbs-invoice.mjs
// Genere une facture d'acompte en PDF (pdf-lib, pur JS, sans fichier de police
// externe : parfait en serverless) et fournit un numero de facture continu.
import { getStore } from "@netlify/blobs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Emetteur (auto-entrepreneur, sans TVA)
const ISSUER = {
  enseigne: "Mybabyshoot",
  nom: "Matteo Guerra",
  adresse: "16 chemin du Buisset, 69350 La Mulatière",
  siret: "807 463 443",
  tel: "06 47 76 54 17",
  email: "mybabyshoot.contact@gmail.com",
  mentionTva: "TVA non applicable, art. 293 B du CGI"
};

// Numero de facture continu, remis a 1 chaque annee, stocke dans un blob
// dedie (jamais ecrase par le CRM). Format MBS-AAAA-NNN.
export async function nextInvoiceNumber(){
  const store = getStore({ name: "mbs-invoices", consistency: "strong" });
  const year = new Date().getFullYear();
  let s = (await store.get("seq", { type: "json" })) || { year, n: 0 };
  if (s.year !== year) s = { year, n: 0 };
  s.n += 1;
  await store.setJSON("seq", s);
  return "MBS-" + year + "-" + String(s.n).padStart(3, "0");
}

function eur(n){ return Number(n).toFixed(2).replace(".", ",") + " EUR"; }

// inv : { number, dateStr, client:{name,email}, typeLabel, seanceDateFr, time, acompte, total }
export async function makeInvoicePdf(inv){
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842, M = 50;
  const ink = rgb(0.16, 0.12, 0.07), soft = rgb(0.45, 0.40, 0.33), line = rgb(0.85, 0.80, 0.72);
  const T = (x, yTop, str, size, f, c) => page.drawText(String(str), { x, y: H - yTop, size, font: f || font, color: c || ink });

  // Emetteur
  T(M, 62, ISSUER.enseigne, 22, bold);
  T(M, 84, ISSUER.nom, 10, font, soft);
  T(M, 98, ISSUER.adresse, 10, font, soft);
  T(M, 112, "SIRET " + ISSUER.siret, 10, font, soft);
  T(M, 126, ISSUER.tel + "   " + ISSUER.email, 10, font, soft);

  // Bloc facture (droite)
  T(360, 62, "FACTURE D'ACOMPTE", 15, bold);
  T(360, 84, "Facture n " + inv.number, 10, font, soft);
  T(360, 98, "Date : " + inv.dateStr, 10, font, soft);

  // separateur
  page.drawLine({ start: { x: M, y: H - 150 }, end: { x: 545, y: H - 150 }, thickness: 1, color: line });

  // Client
  T(M, 182, "Facturé à", 10, bold, soft);
  T(M, 198, inv.client.name || "Client", 12, bold);
  if (inv.client.email) T(M, 214, inv.client.email, 10, font, soft);

  // Tableau
  const yTable = 262;
  T(M, yTable, "Description", 10, bold, soft);
  T(430, yTable, "Montant", 10, bold, soft);
  page.drawLine({ start: { x: M, y: H - (yTable + 8) }, end: { x: 545, y: H - (yTable + 8) }, thickness: 0.8, color: line });

  T(M, yTable + 30, "Acompte - Séance " + inv.typeLabel, 11, font);
  T(M, yTable + 46, "du " + inv.seanceDateFr + " à " + inv.time + " (studio, La Mulatière)", 9.5, font, soft);
  T(430, yTable + 30, eur(inv.acompte), 11, bold);

  page.drawLine({ start: { x: M, y: H - (yTable + 66) }, end: { x: 545, y: H - (yTable + 66) }, thickness: 0.8, color: line });

  // Total
  T(300, yTable + 92, "Total acompte à payer", 11, bold);
  T(430, yTable + 92, eur(inv.acompte), 12, bold);

  // Mention TVA
  T(M, yTable + 130, ISSUER.mentionTva, 9.5, font, soft);

  // Note solde
  const reste = Math.max(0, Number(inv.total) - Number(inv.acompte));
  T(M, yTable + 160, "Acompte versé pour réserver la date de la séance.", 10, font);
  T(M, yTable + 176, "Solde de " + eur(reste) + " à régler le jour de la séance.", 10, font);

  // Pied de page
  T(M, 800, ISSUER.enseigne + " . " + ISSUER.nom + " . SIRET " + ISSUER.siret + " . " + ISSUER.mentionTva, 8, font, soft);

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
