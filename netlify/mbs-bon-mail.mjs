// netlify/mbs-bon-mail.mjs
// Le courrier qui porte un bon cadeau.
//
// Il etait ecrit en clair dans mbs-webhook.js, ce qui allait tant qu'un
// seul endroit l'envoyait. Depuis que Matt peut corriger un bon et le
// renvoyer depuis son CRM, deux endroits l'envoient. Deux copies d'un
// meme modele finissent toujours par diverger, et c'est la cliente qui
// s'en apercoit. Il vit donc ici, en un seul exemplaire.
//
// Rien n'est invente : le contenu est celui du courrier d'origine, mot
// pour mot.
import { prettyGift, frDateShort } from "./mbs-coupons.mjs";

export const SEANCE_TXT = {
  grossesse: "Séance grossesse",
  naissance: "Séance naissance",
  duo:       "Grossesse et naissance"
};

/* Le bloc encadre qui ressemble au bon lui-meme. Le montant en est
   volontairement absent : celui qui recoit le cadeau n'a pas a decouvrir
   son prix, meme si l'email lui est transfere. */
export function htmlBonCadeau({ prenom = "", pour = "", mot = "", label = "",
                                seance = "grossesse", code = "", expiresAt = 0,
                                montant = 0, site = "", avecFacture = false }) {
  const lien = site + "/bon.html?code=" + code;
  return "<p>Bonjour " + prenom + " !</p>" +
    "<p>Tout d'abord, merci pour votre confiance !</p>" +
    "<p>Voici le bon cadeau" + (pour ? " pour " + pour : "") + ", prêt à être offert.</p>" +
    "<p style=\"margin:22px 0\"><a href=\"" + lien + "\" style=\"background:#5E4430;color:#FAF4EA;padding:14px 26px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold\">Voir et imprimer le bon cadeau</a></p>" +
    "<p>Ce lien ouvre votre bon en grand : vous pouvez le <b>télécharger en image</b> pour l'imprimer et l'offrir en main propre, ou simplement transmettre le code.</p>" +
    "<div style=\"border:2px solid #5E4430;border-radius:16px;padding:24px;text-align:center;font-family:Georgia,serif;max-width:420px\">" +
      "<div style=\"letter-spacing:3px;font-size:12px;color:#8a7a6a\">MYBABYSHOOT</div>" +
      "<div style=\"font-size:22px;margin:10px 0 4px\">Bon cadeau</div>" +
      "<div style=\"font-size:18px;font-weight:bold\">" + (label || "") + "</div>" +
      "<div style=\"font-size:15px;color:#8a7a6a;margin-bottom:14px\">" + (SEANCE_TXT[seance] || "") + "</div>" +
      (pour ? "<div style=\"margin-top:8px\">Pour " + pour + "</div>" : "") +
      (mot ? "<div style=\"margin-top:8px;font-style:italic\">" + mot + "</div>" : "") +
      "<div style=\"margin:18px 0 4px;font-size:12px;color:#8a7a6a\">CODE À UTILISER</div>" +
      "<div style=\"font-size:26px;letter-spacing:4px;font-weight:bold\">" + prettyGift(code) + "</div>" +
      "<div style=\"margin-top:14px;font-size:12px;color:#8a7a6a\">Valable jusqu'au " + frDateShort(expiresAt) + "</div>" +
    "</div>" +
    "<p style=\"font-size:13px;color:#888\">Montant réglé : " + montant + " €"
    + (avecFacture ? ", votre facture est en pièce jointe" : "")
    + ". Le prix n'apparaît nulle part sur le bon.</p>" +
    "<p style=\"margin-top:18px\">Comment l'utiliser : rendez-vous sur <a href=\"" + site + "/#tarifs\">" + site.replace(/^https?:\/\//, "") + "</a>, "
    + "puis saisissez le code, choisissez la date et le créneau et réservez. La séance est déjà réglée, il n'y aura rien à payer.</p>" +
    "<p>Ce bon est à usage unique : gardez le code précieusement.</p>" +
    "<p>Une question ? Répondez à cet email ou appelez le 06 47 76 54 17.</p>" +
    "<p>À très vite<br>Matteo · Mybabyshoot</p>";
}

/* Le meme bon, renvoye apres une correction. On ne refait pas le courrier
   de remerciement : l'acheteur a deja paye et deja recu son bon. On lui
   dit ce qui a change, puis on remontre le bon corrige. */
export function htmlBonCorrige({ prenom = "", pour = "", mot = "", label = "",
                                 seance = "grossesse", code = "", expiresAt = 0,
                                 montant = 0, site = "", explication = "" }) {
  const complet = htmlBonCadeau({ prenom, pour, mot, label, seance, code, expiresAt, montant, site });
  /* On retire les deux premieres lignes du courrier d'origine (le bonjour
     et le remerciement) pour les remplacer par l'explication. */
  const corps = complet.split("<p>Voici le bon cadeau").slice(1).join("<p>Voici le bon cadeau");
  return "<p>Bonjour " + prenom + " !</p>" +
    "<p>" + (explication || "Votre bon cadeau a été corrigé.") + "</p>" +
    "<p><b>Le code ne change pas</b> : " + prettyGift(code) + ". L'ancien lien reste valable, il affiche déjà la version corrigée.</p>" +
    "<p>Voici le bon cadeau" + corps;
}
