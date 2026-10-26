// netlify/functions/mlp-formation.js
// La formation "Oser", cote eleve : formation.html et cours.html du site
// Matt la Photo. Le fonctionnement est decrit dans ../mlp-formation.mjs.
//
// PUBLIC. Appele depuis un autre domaine (mattlaphoto.netlify.app) : pas de
// cookie, l'appareil connecte garde son jeton et l'envoie dans l'en-tete
// Authorization.
//
//   GET                                      : vente ouverte ? prix ? video de presentation
//   POST {action:"acheter", renonce:true}    : la page de paiement Stripe
//   POST {action:"code", session}            : le code, apres le paiement
//   POST {action:"activer", code, email, mdp}: creer son compte (le code expire)
//   POST {action:"connexion", email, mdp}
//   POST {action:"cours"}          + jeton   : les lecons
//   POST {action:"deconnexion"}    + jeton
//   POST {action:"oubli", email}             : lien "mot de passe oublie"
//   POST {action:"reinit", t, mdp}           : nouveau mot de passe
import Stripe from "stripe";
import { FORMATION, normaliserEmail, emailValide, afficherCode, codePourVente, lireCode,
         activer, connecter, compteDuJeton, deconnecter, demanderReinit, reinitialiser,
         lireReglages, lireLecons } from "../mlp-formation.mjs";
import { porteFermee, noterEchec, LIMITE_CODES } from "../mbs-garde.mjs";
import { marqueDe } from "../marques.mjs";
import { sendMail } from "../mbs-mail.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});
/* La formation tutoie, comme Matt dans ses videos (choix du 24/10/2026). */
const MESSAGE_TROP = "Trop d'essais. Réessaie dans une heure, ou écris-moi à mattlaphototiktok@gmail.com.";
/* Les mots de passe : 10 echecs par heure et par adresse, comme les codes.
   Un eleve qui se trompe trois fois n'est pas gene ; un robot, si. */
const LIMITE_MDP = LIMITE_CODES;
const MARQUE = marqueDe("matt-la-photo");
const esc = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const jetonDe = (request) => (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const secret = MARQUE.stripeSecret();

  if (request.method === "GET") {
    const r = await lireReglages();
    return json({ ok: true, nom: FORMATION.nom, prix: FORMATION.prix, ouverte: !!r.ouverte, paiement: !!secret,
      presentation: r.presentation });
  }
  if (request.method !== "POST") return json({ ok: false }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = String(body.action || "");

  /* ---------- acheter ---------- */
  if (action === "acheter") {
    const r = await lireReglages();
    if (!r.ouverte) return json({ ok: false, erreur: "fermee" }, 409);
    if (!secret) return json({ ok: false, erreur: "paiement",
      message: "Le paiement en ligne n'est pas encore disponible. Écris-moi à mattlaphototiktok@gmail.com." }, 503);
    /* Un contenu numerique auquel on accede tout de suite : le droit de
       retractation ne s'applique que si l'acheteur y renonce expressement
       (article L221-28, 13° du code de la consommation). La case est
       cochee sur la page ; on verifie ici, et on garde la date. */
    if (body.renonce !== true) return json({ ok: false, erreur: "renonce" }, 400);
    const site = MARQUE.site();
    try {
      const session = await new Stripe(secret).checkout.sessions.create({
        mode: "payment",
        /* La carte seule : 49 euros ne s'etalent pas en 3 fois (Klarna
           commence a 150), et la carte a cote de Klarna ouvrirait Link. */
        payment_method_types: ["card"],
        line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: Math.round(FORMATION.prix * 100),
          product_data: { name: FORMATION.libelle } } }],
        success_url: site + "/formation.html?achat={CHECKOUT_SESSION_ID}",
        cancel_url: site + "/formation.html",
        metadata: { app: "mlp-formation", renonce: new Date().toISOString(), site }
      });
      return json({ ok: true, url: session.url });
    } catch (e) {
      return json({ ok: false, erreur: "stripe", message: "Le paiement n'a pas pu s'ouvrir. Réessaie dans un instant." }, 502);
    }
  }

  /* ---------- le code, sur la page de remerciement ----------
     Le webhook peut arriver apres la personne : on demande a Stripe si la
     session est payee, et on cree le code si le webhook ne l'a pas deja
     fait. C'est le meme code dans les deux cas (voir codeDeSession). */
  if (action === "code") {
    if (await porteFermee("formation-achat", request, LIMITE_CODES)) return json({ ok: false, erreur: "trop", message: MESSAGE_TROP }, 429);
    const id = String(body.session || "");
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,}$/.test(id) || !secret) {
      await noterEchec("formation-achat", request, LIMITE_CODES);
      return json({ ok: false, erreur: "introuvable" }, 404);
    }
    let s = null;
    try { s = await new Stripe(secret).checkout.sessions.retrieve(id); } catch (e) {}
    if (!s || (s.metadata || {}).app !== "mlp-formation") {
      await noterEchec("formation-achat", request, LIMITE_CODES);
      return json({ ok: false, erreur: "introuvable" }, 404);
    }
    if (s.payment_status !== "paid") return json({ ok: false, erreur: "attente" }, 409);
    const email = (s.customer_details && s.customer_details.email) || s.customer_email || "";
    const v = await codePourVente({ sessionId: s.id, email, montant: Math.round((s.amount_total || 0) / 100) });
    const c = await lireCode(v.code);
    return json({ ok: true, code: afficherCode(v.code), email: v.email, utilise: !!(c && c.statut !== "libre") });
  }

  /* ---------- creer son compte avec son code ---------- */
  if (action === "activer") {
    if (await porteFermee("formation-code", request, LIMITE_CODES)) return json({ ok: false, erreur: "trop", message: MESSAGE_TROP }, 429);
    const r = await activer({ code: body.code, email: body.email, mdp: body.mdp });
    /* Seul un code inconnu compte comme un essai : c'est ce qu'un robot
       ferait en boucle. */
    if (!r.ok && r.erreur === "code") await noterEchec("formation-code", request, LIMITE_CODES);
    return json(r, r.ok ? 200 : 400);
  }

  if (action === "connexion") {
    if (await porteFermee("formation-mdp", request, LIMITE_MDP)) return json({ ok: false, erreur: "trop", message: MESSAGE_TROP }, 429);
    const r = await connecter({ email: body.email, mdp: body.mdp });
    if (!r.ok) await noterEchec("formation-mdp", request, LIMITE_MDP);
    return json(r, r.ok ? 200 : 400);
  }

  /* ---------- les lecons ---------- */
  if (action === "cours") {
    const r = await compteDuJeton(jetonDe(request));
    if (!r) return json({ ok: false, erreur: "session" }, 401);
    const lecons = (await lireLecons()).map(l => ({ id: l.id, titre: l.titre, texte: l.texte, video: l.video }));
    return json({ ok: true, nom: FORMATION.nom, email: r.compte.email, lecons });
  }

  if (action === "deconnexion") {
    await deconnecter(jetonDe(request));
    return json({ ok: true });
  }

  /* ---------- mot de passe oublie ----------
     La reponse est la meme que l'adresse ait un compte ou non : sinon la
     page servirait a verifier qui a achete la formation. Chaque demande
     compte, pour qu'on ne puisse pas inonder une boite de mails. */
  if (action === "oubli") {
    if (await porteFermee("formation-oubli", request, LIMITE_CODES)) return json({ ok: false, erreur: "trop", message: MESSAGE_TROP }, 429);
    await noterEchec("formation-oubli", request, LIMITE_CODES);
    const em = normaliserEmail(body.email);
    if (!emailValide(em)) return json({ ok: false, erreur: "email" }, 400);
    if (!process.env.MLP_SMTP_USER || !process.env.MLP_SMTP_PASS)
      return json({ ok: false, erreur: "mail", message: "L'envoi de mails n'est pas encore en place. Écris-moi à mattlaphototiktok@gmail.com." }, 503);
    const d = await demanderReinit(em);
    if (d) {
      const lien = MARQUE.site() + "/cours.html#reinit=" + d.t;
      try {
        await sendMail({ to: d.email, marque: MARQUE.cle, bcc: null,
          subject: "Votre mot de passe · formation « " + FORMATION.nom + " »",
          html: "<p>Salut,</p><p>Pour choisir un nouveau mot de passe, ouvre ce lien dans l'heure :</p>"
            + "<p><a href=\"" + esc(lien) + "\" style=\"display:inline-block;background:#FF7518;color:#fff;padding:12px 20px;"
            + "border-radius:999px;text-decoration:none;font-weight:bold\">Choisir mon mot de passe</a></p>"
            + "<p style=\"color:#888;font-size:13px\">Tu n'as rien demandé ? Ignore ce mail, rien ne change.</p>"
            + "<p>" + esc(MARQUE.signature) + "</p>" });
      } catch (e) {}
    }
    return json({ ok: true });
  }

  if (action === "reinit") {
    if (await porteFermee("formation-code", request, LIMITE_CODES)) return json({ ok: false, erreur: "trop", message: MESSAGE_TROP }, 429);
    const r = await reinitialiser({ t: body.t, mdp: body.mdp });
    if (!r.ok && r.erreur === "lien") await noterEchec("formation-code", request, LIMITE_CODES);
    return json(r, r.ok ? 200 : 400);
  }

  return json({ ok: false, erreur: "action" }, 400);
};

/* Une adresse neutre pour le site Matt la Photo, comme la galerie. */
export const config = { path: ["/.netlify/functions/mlp-formation", "/formation-api"] };
