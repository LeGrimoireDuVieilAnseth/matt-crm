// netlify/mbs-mail.mjs
// Envoi SMTP partage (boite mail de Matt, identifiants dans les variables Netlify).
// Ne leve jamais : un email rate ne doit jamais casser une reservation.
import nodemailer from "nodemailer";

/* marque "matt-la-photo" : sa propre boite (MLP_SMTP_USER, MLP_SMTP_PASS...),
   JAMAIS celle de Mybabyshoot. Sans elle, le mail ne part pas. Seul le
   serveur d'envoi peut etre commun (MLP_SMTP_HOST, sinon celui de
   Mybabyshoot, par exemple smtp.gmail.com) : il ne se voit pas. */
export async function sendMail({ to, subject, html, attachments, bcc, marque }) {
  const P = marque === "matt-la-photo" ? "MLP_" : "MBS_";
  const env = (k) => process.env[P + k];
  const host = env("SMTP_HOST") || process.env.MBS_SMTP_HOST;
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("FROM_EMAIL") || user;
  if (!host || !user || !pass || !to) return false; // SMTP non configure : on n'envoie rien
  const port = Number(env("SMTP_PORT") || process.env.MBS_SMTP_PORT || 465);
  const sec = env("SMTP_SECURE") || process.env.MBS_SMTP_SECURE;
  const secure = sec ? (sec === "true") : (port === 465);
  const copie = bcc === null ? undefined
    : (bcc || env("INVOICE_EMAIL") || (P === "MBS_" ? "mybabyshoot.contact@gmail.com" : user));
  try {
    const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transport.sendMail({ from, to, bcc: copie, subject, html, attachments: attachments || [] });
    return true;
  } catch (e) { return false; }
}
