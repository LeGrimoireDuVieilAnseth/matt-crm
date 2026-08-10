// netlify/mbs-mail.mjs
// Envoi SMTP partage (boite mail de Matt, identifiants dans les variables Netlify).
// Ne leve jamais : un email rate ne doit jamais casser une reservation.
import nodemailer from "nodemailer";

export async function sendMail({ to, subject, html, attachments, bcc }) {
  const host = process.env.MBS_SMTP_HOST;
  const user = process.env.MBS_SMTP_USER;
  const pass = process.env.MBS_SMTP_PASS;
  const from = process.env.MBS_FROM_EMAIL || user;
  if (!host || !user || !pass || !to) return false; // SMTP non configure : on n'envoie rien
  const port = Number(process.env.MBS_SMTP_PORT || 465);
  const secure = process.env.MBS_SMTP_SECURE ? (process.env.MBS_SMTP_SECURE === "true") : (port === 465);
  const copie = bcc === null ? undefined : (bcc || process.env.MBS_INVOICE_EMAIL || "mybabyshoot.contact@gmail.com");
  try {
    const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transport.sendMail({ from, to, bcc: copie, subject, html, attachments: attachments || [] });
    return true;
  } catch (e) { return false; }
}
