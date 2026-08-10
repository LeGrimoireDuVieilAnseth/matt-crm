// netlify/functions/mbs-relances.js
// Fonction planifiee (1 fois par jour) : relance album apres la seance.
// L'album (140 euros) se vend beaucoup mieux juste apres la seance,
// quand la cliente vient de decouvrir ses photos.
// Chaque seance n'est relancee QU'UNE SEULE FOIS (champ albumMailAt).
import nodemailer from "nodemailer";
import { crmStore, loadData, BRAND } from "../mbs-lib.mjs";

const JOURS_APRES = 4;      // on relance 4 jours apres la seance
const FENETRE     = 10;     // on ne remonte pas au-dela de 10 jours (rattrapage)

function frDate(iso) {
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}
function joursEcoules(iso) {
  const p = String(iso).split("-").map(Number);
  if (p.length !== 3) return -1;
  const d = Date.UTC(p[0], p[1] - 1, p[2]);
  const t = new Date();
  const auj = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((auj - d) / 86400000);
}

async function sendMail({ to, subject, html }) {
  const host = process.env.MBS_SMTP_HOST;
  const user = process.env.MBS_SMTP_USER;
  const pass = process.env.MBS_SMTP_PASS;
  const from = process.env.MBS_FROM_EMAIL || user;
  if (!host || !user || !pass || !to) return false;
  const port = Number(process.env.MBS_SMTP_PORT || 465);
  const secure = process.env.MBS_SMTP_SECURE ? (process.env.MBS_SMTP_SECURE === "true") : (port === 465);
  const bcc = process.env.MBS_INVOICE_EMAIL || "mybabyshoot.contact@gmail.com";
  try {
    const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transport.sendMail({ from, to, bcc, subject, html });
    return true;
  } catch (e) { return false; }
}

export default async () => {
  const store = crmStore();
  const data  = await loadData(store);
  const site  = (process.env.MBS_SITE_URL || "https://mybabyshoot.fr").replace(/\/+$/, "");
  const now   = Date.now();
  let envoyes = 0;

  const seances = (data.seances || []).filter(s =>
    s.brand === BRAND &&
    s.type !== "Indispo" &&
    s.type !== "RDV telephonique" &&
    s.status !== "Annulee" &&
    !s.albumMailAt
  );

  for (const s of seances) {
    const j = joursEcoules(s.date);
    if (j < JOURS_APRES || j > FENETRE) continue;

    const client = (data.clients || []).find(c => c.id === s.clientId);
    if (!client || !client.email) { s.albumMailAt = now; continue; } // rien a envoyer

    // deja un album commande ? on ne relance pas
    const dejaAlbum = (data.paiements || []).some(p =>
      p.clientId === client.id && /album/i.test(String(p.label || "") + String(p.notes || "")));
    if (dejaAlbum) { s.albumMailAt = now; continue; }

    const prenom = String(client.name || "").split(" ")[0] || "";
    const html =
      "<p>Bonjour " + prenom + ",</p>" +
      "<p>J'espere que vous avez passe un bon moment au studio le " + frDate(s.date) + " et que vos photos vous plaisent.</p>" +
      "<p>Beaucoup de familles me demandent, une fois la galerie decouverte, s'il est possible d'avoir leurs images <b>imprimees</b>. La reponse est oui : je propose un <b>album photo imprime a 140 euros</b>, qui reunit vos plus belles images dans un bel objet a garder et a feuilleter, bien plus vivant qu'un ecran.</p>" +
      "<p>C'est aussi le cadeau qui touche le plus les grands-parents.</p>" +
      "<p>Si cela vous tente, repondez simplement a cet email ou appelez-moi au <b>06 47 76 54 17</b>, je m'occupe de tout.</p>" +
      "<p>Encore merci de votre confiance,<br>Matteo . Mybabyshoot<br><a href=\"" + site + "\">" + site.replace(/^https?:\/\//, "") + "</a></p>";

    const ok = await sendMail({
      to: client.email,
      subject: "Vos photos en album imprime ?",
      html
    });
    s.albumMailAt = now;          // marque dans tous les cas : jamais deux fois
    if (ok) envoyes++;
  }

  data.t = now;
  await store.setJSON("data", data);

  return new Response(JSON.stringify({ ok: true, envoyes }), {
    headers: { "Content-Type": "application/json" }
  });
};

// Une fois par jour, a 10h UTC.
export const config = { schedule: "0 10 * * *" };
