// netlify/functions/mbs-lien-admin.js
// Les liens de paiement, cote CRM. Protege par le mot de passe (CRM_KEY).
//
//   GET  ?liens=1                : tous les liens, du plus recent au plus ancien
//   GET  ?client=ID              : ceux d'une cliente
//   POST {action:"creer", ...}   : cree un lien et rend son adresse
//   POST {action:"annuler", code}: eteint un lien non paye
//   POST {action:"envoyer", code}: envoie le lien par mail a la cliente
import { lienStore, creerLien, majIndex, normaliserCode, montantValide,
         vuePublique, optionsDe, extrasDe, aDesExtras, normaliserExtras,
         LIEN_MIN, LIEN_MAX } from "../mbs-liens.mjs";
import { sendMail } from "../mbs-mail.mjs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

function autorise(request) {
  const attendu = process.env.CRM_KEY || "";
  if (!attendu) return true;
  return (request.headers.get("x-crm-key") || "") === attendu;
}

const siteUrl = () =>
  (process.env.MBS_SITE_URL || "https://www.mybabyshoot.fr").replace(/\/+$/, "");

const adresseDuLien = (code) => siteUrl() + "/payer.html?c=" + code;

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default async (request) => {
  if (!autorise(request)) return json({ ok: false, erreur: "non autorise" }, 401);
  const store = lienStore();
  const url = new URL(request.url);

  if (request.method === "GET") {
    let idx = [];
    try { idx = (await store.get("liens", { type: "json" })) || []; } catch (e) {}
    const client = url.searchParams.get("client");
    const liste = (client ? idx.filter(l => l.clientId === client) : idx).slice(0, 200);
    return json({ ok: true, liens: liste.map(l => ({ ...l, url: adresseDuLien(l.code) })) });
  }

  if (request.method !== "POST") return json({ ok: false, erreur: "methode refusee" }, 405);
  let corps;
  try { corps = await request.json(); }
  catch (e) { return json({ ok: false, erreur: "json" }, 400); }

  /* ---------- creer ---------- */
  if (corps.action === "creer") {
    /* Le CRM envoie soit une liste de marches, soit un montant unique
       (l'ancienne forme, et celle du "autre montant"). On verifie ce qu'on
       recoit avant de creer : un lien sans prix ou sans libelle produirait
       une page muette, et une facture sans intitule. */
    const marches = Array.isArray(corps.options) ? corps.options : [];
    const sup = normaliserExtras(corps.extras);
    /* Un lien qui ne propose que des complements n'a pas de montant : son
       total depend de ce que la cliente cochera. */
    if (!marches.length && aDesExtras(sup)) {
      /* rien a verifier de plus : les prix des complements sont au serveur */
    } else if (marches.length) {
      const mauvaise = marches.find(o =>
        montantValide(o && o.montant) === null || !String((o && o.titre) || "").trim());
      if (mauvaise) {
        return json({ ok: false, erreur: "options",
          message: `Chaque proposition doit avoir un intitulé et un montant entre ${LIEN_MIN} et ${LIEN_MAX} euros.` }, 400);
      }
    } else {
      if (montantValide(corps.montant) === null) {
        return json({ ok: false, erreur: "montant",
          message: `Le montant doit être un nombre entre ${LIEN_MIN} et ${LIEN_MAX} euros.` }, 400);
      }
      if (!String(corps.libelle || "").trim()) {
        return json({ ok: false, erreur: "libelle",
          message: "Écris ce que la cliente règle : elle le verra sur la page et sur sa facture." }, 400);
      }
    }
    const lien = await creerLien(store, {
      clientId: corps.clientId, prenom: corps.prenom, nom: corps.nom,
      email: corps.email,
      montant: montantValide(corps.montant), libelle: String(corps.libelle || "").trim(),
      argument: corps.argument, gains: corps.gains, options: marches, extras: sup,
    });
    if (!lien) return json({ ok: false, erreur: "code" }, 500);
    return json({ ok: true, lien: vuePublique(lien), url: adresseDuLien(lien.code) });
  }

  /* ---------- annuler ---------- */
  if (corps.action === "annuler") {
    const code = normaliserCode(corps.code);
    let l = null;
    try { l = await store.get("l-" + code, { type: "json" }); } catch (e) {}
    if (!l) return json({ ok: false, erreur: "introuvable" }, 404);
    /* Un lien deja paye ne s'annule pas : l'argent est encaisse, et une
       facture porte son numero. Effacer la trace serait pire que tout. */
    if (l.statut === "paye") {
      return json({ ok: false, erreur: "deja_paye",
        message: "Ce lien a déjà été réglé, il ne peut plus être annulé." }, 400);
    }
    l.statut = "annule";
    await store.setJSON("l-" + code, l);
    await majIndex(store, code, { statut: "annule" });
    return json({ ok: true });
  }

  /* ---------- envoyer par mail ---------- */
  if (corps.action === "envoyer") {
    const code = normaliserCode(corps.code);
    let l = null;
    try { l = await store.get("l-" + code, { type: "json" }); } catch (e) {}
    if (!l) return json({ ok: false, erreur: "introuvable" }, 404);
    if (l.statut !== "attente") {
      return json({ ok: false, erreur: "etat",
        message: l.statut === "paye" ? "Ce lien est déjà réglé." : "Ce lien a été annulé." }, 400);
    }
    const email = String(corps.email || l.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ ok: false, erreur: "email", message: "Aucune adresse valable pour cette cliente." }, 400);
    }
    const lien = adresseDuLien(l.code);
    /* Le mail ne refait pas l'argumentaire : c'est la page qui le porte, et
       Matt l'y a relu. Il dit juste ce qui l'attend, et quand il y a
       plusieurs marches il les nomme -- sinon le mail annoncerait un seul
       montant et la page en montrerait trois. */
    const marches = optionsDe(l);
    const extras = extrasDe(l);
    const aLaCarte = aDesExtras(extras);
    const quoi = [];
    if (extras.photos)  quoi.push("des photos retouchées en plus");
    if (extras.album)   quoi.push("un album imprimé");
    if (extras.tirages) quoi.push("des tirages papier");
    const plusieurs = marches.length > 1;
    const intro = aLaCarte
      ? "<p>Voici de quoi compléter votre séance"
        + (quoi.length ? " : " + quoi.join(", ") : "")
        + ". Vous choisissez ce que vous voulez sur la page, et vous voyez le total avant de régler.</p>"
        + (marches.length ? "<ul style=\"padding-left:18px;line-height:1.7\">"
            + marches.map(o => "<li>" + esc(o.titre) + " · <b>" + o.montant + " €</b></li>").join("")
            + "</ul>" : "")
      : plusieurs
      ? "<p>Voici les possibilités dont nous avons parlé. Vous choisissez celle que vous voulez sur la page, il n'y a aucune obligation.</p>"
        + "<ul style=\"padding-left:18px;line-height:1.7\">"
        + marches.map(o => "<li>" + esc(o.titre) + " · <b>" + o.montant + " €</b></li>").join("")
        + "</ul>"
      : "<p>Voici le lien pour régler " + esc(l.libelle) + ".</p>";
    const texteBouton = (aLaCarte || plusieurs) ? "Voir et choisir" : "Régler " + l.montant + " €";
    const html =
      "<p>Bonjour " + esc(l.prenom) + " !</p>" +
      intro +
      "<p style=\"margin:22px 0\"><a href=\"" + lien + "\" style=\"background:#5E4430;color:#FAF4EA;padding:14px 26px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold\">" + texteBouton + "</a></p>" +
      "<p style=\"font-size:13px;color:#888\">Le paiement se fait en ligne, de façon sécurisée. Votre facture vous sera envoyée automatiquement dès le règlement.</p>" +
      "<p>Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :<br>" +
      "<span style=\"font-size:13px\">" + lien + "</span></p>" +
      "<p>Une question ? Répondez à cet email ou appelez le 06 47 76 54 17.</p>" +
      "<p>À très vite<br>Matteo · Mybabyshoot</p>";
    try {
      await sendMail({ to: email, subject: "Votre lien de paiement · Mybabyshoot", html });
    } catch (e) {
      return json({ ok: false, erreur: "envoi", message: "L'envoi a échoué : " + (e.message || e) }, 502);
    }
    return json({ ok: true, envoyeA: email });
  }

  return json({ ok: false, erreur: "action inconnue" }, 400);
};
