// netlify/marques.mjs
/* LES MARQUES QUI ONT UNE GALERIE (24/10/2026).

   Mybabyshoot depuis le 20/10/2026, Matt la Photo depuis le 24/10/2026
   (shootings perso payants et collabs marques). Meme moteur de galerie,
   meme compte Stripe, meme SIRET : ce qui change, c'est le site qui sert la
   page de la cliente, le nom sur la facture et dans les mails, et les
   couleurs des boutons.

   La marque d'une galerie vient de la FICHE de la cliente (champ brand du
   CRM), jamais du navigateur. */
const propre = (u) => String(u || "").replace(/\/+$/, "");

export const MARQUES = {
  "mybabyshoot": {
    cle: "mybabyshoot",
    nom: "Mybabyshoot",
    site: () => propre(process.env.MBS_SITE_URL || "https://www.mybabyshoot.fr"),
    signature: "Matteo · Mybabyshoot",
    instagram: "@mybabyshoot",
    /* Variables Netlify : MBS_SMTP_*, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. */
    stripeSecret: () => process.env.STRIPE_SECRET_KEY || "",
    serieFactures: "MBS",
    email: () => "mybabyshoot.contact@gmail.com",
    /* Les boutons des mails : retouches, galerie, avis. */
    couleurs: { retouches: "#C97B63", galerie: "#8A8078", avis: "#6B6B6B", principal: "#5E4430" },
    reglageAvis: "avisMybabyshoot",
  },
  "matt-la-photo": {
    cle: "matt-la-photo",
    nom: "Matt la Photo",
    /* Le site de la galerie Matt la Photo. Variable MLP_SITE_URL dans
       Netlify si l'adresse change (nom de domaine a lui, plus tard). */
    site: () => propre(process.env.MLP_SITE_URL || "https://mattlaphoto.netlify.app"),
    signature: "Matt · Matt la Photo",
    instagram: "@matt_la_photo",
    /* Ses PROPRES variables Netlify, sans repli sur Mybabyshoot :
       MLP_SMTP_USER / MLP_SMTP_PASS (et MLP_FROM_EMAIL, MLP_INVOICE_EMAIL),
       MLP_STRIPE_SECRET_KEY / MLP_STRIPE_WEBHOOK_SECRET (son compte Stripe). */
    stripeSecret: () => process.env.MLP_STRIPE_SECRET_KEY || "",
    serieFactures: "MLP",
    email: () => process.env.MLP_FROM_EMAIL || process.env.MLP_SMTP_USER || "",
    /* Bleu canard et orange, les couleurs de Matt la Photo. */
    couleurs: { retouches: "#FF7518", galerie: "#003366", avis: "#5A6B82", principal: "#003366" },
    reglageAvis: "avisMatt",
  },
};
export const MARQUES_GALERIE = Object.keys(MARQUES);
export const marqueDe = (cle) => MARQUES[cle] || MARQUES.mybabyshoot;
