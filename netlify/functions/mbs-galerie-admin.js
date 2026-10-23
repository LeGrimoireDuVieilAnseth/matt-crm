// netlify/functions/mbs-galerie-admin.js
// La galerie legere, cote CRM (protege par CRM_KEY, voir mbs-garde.mjs).
//
//   GET  ?liste=1                                  : les galeries
//   GET  ?g=JETON                                  : une galerie, selection comprise
//   POST {action:"creer", clientId, formule, seance, transfert, photos:[{nom}], quota}
//        deux seances : formule "duo", formules {grossesse, naissance},
//        photos:[{nom, seance}], transferts {grossesse, naissance}
//   POST {action:"ajouter-seance", g, seance, transfert, photos:[{nom}]} : la naissance, plus tard
//   POST {action:"images", g, items:[{id, t, v}]}  : vignettes et apercus, en base64
//   POST {action:"publier", g}                     : la galerie (ou la seance ajoutee) devient visible
//   POST {action:"quota", g, quota}                : le total de retouches comprises
//   POST {action:"transfert", g, lien, seance}     : remplacer le lien "tout telecharger"
//   POST {action:"retouches", g, lien, prevenir, tour} : le lien des photos retouchees
//   POST {action:"couverture", g, id, seance}      : la photo de bienvenue (d'une seance)
//   POST {action:"supprimer", g}
//
// Les images arrivent DEJA allegees par le navigateur de Matt. Ici on ne
// fait que les ranger, en refusant ce qui est trop lourd pour etre un
// apercu : une photo en pleine qualite deposee par erreur couterait de la
// bande passante a chaque ouverture.
import { galerieStore, creerGalerie, lireGalerie, enregistrer, supprimerGalerie, lienValide, ligneIndex,
         normaliserJeton, idPhotoValide, ajouterSeance, nouveauChoix, quotaSaisi, comprisesDe,
         POIDS_MAX_VIGNETTE, POIDS_MAX_APERCU, IMAGES_PAR_ENVOI } from "../mbs-galeries.mjs";
import { crmStore, loadData } from "../mbs-lib.mjs";
import { sendMail } from "../mbs-mail.mjs";
import { cleCRM, statutRefus, MESSAGE_TROP_CRM } from "../mbs-garde.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-CRM-Key"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const siteUrl = () =>
  (process.env.MBS_SITE_URL || "https://www.mybabyshoot.fr").replace(/\/+$/, "");
const adresseGalerie = (jeton) => siteUrl() + "/galerie.html?g=" + jeton;

/* Le controle de la cle vit dans mbs-garde.mjs : il refuse tout si CRM_KEY
   manque, et bloque une adresse apres trop d'essais rates. */
const refusCle = async (request) => {
  const etat = await cleCRM(request);
  if (etat === "ok") return null;
  return json(etat === "bloque"
    ? { ok: false, error: "trop", message: MESSAGE_TROP_CRM }
    : { ok: false, error: "unauthorized" }, statutRefus(etat));
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------- le mail des retouches ----------
   Meme principe que le mail final (crm-mail-final.js) : le texte est ecrit
   par Matt dans le CRM, modifiable a chaque envoi. Tout ce qu'il tape est
   echappe ; seuls trois reperes, seuls sur leur ligne, deviennent des
   boutons. Le lien d'avis vient des Reglages du CRM (avisMybabyshoot). */
const AVIS_MBS_DEFAUT = "https://g.page/r/CTGWLnQvUCwtEBM/review";   // le meme que crm-mail-final.js
const boutonMail = (href, texte, fond) =>
  '<p style="margin:24px 0"><a href="' + esc(href) + '" style="background:' + fond +
  ';color:#FFFFFF;padding:14px 28px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold">' +
  esc(texte) + "</a></p>";
function htmlRetouches(texte, ctx) {
  const jetons = {
    "[bouton retouches]": boutonMail(ctx.retouches, "Télécharger mes photos retouchées", "#C97B63"),
    "[bouton galerie]": boutonMail(ctx.galerie, "Revoir ma galerie", "#8A8078"),
    "[bouton avis]": ctx.avis ? boutonMail(ctx.avis, "Laisser un avis", "#6B6B6B") : "",
  };
  const blocs = String(texte || "").replace(/\r\n/g, "\n").split(/\n[ \t]*\n/).map(b => b.trim()).filter(Boolean);
  /* Sans le repere des retouches, la cliente recevrait un mail sans son
     lien : on remet le bouton apres le premier paragraphe. */
  if (!blocs.some(b => b.toLowerCase() === "[bouton retouches]")) blocs.splice(Math.min(1, blocs.length), 0, "[bouton retouches]");
  return blocs.map(b => {
    const j = jetons[b.toLowerCase()];
    return j !== undefined ? j : "<p>" + esc(b).replace(/\n/g, "<br>") + "</p>";
  }).join("");
}

/* Une image base64, decodee et pesee. null si ce n'est pas un JPEG ou si
   elle depasse le plafond. */
function image(b64, plafond) {
  if (typeof b64 !== "string" || b64.length > plafond * 1.4) return null;
  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch (e) { return null; }
  if (buf.length < 100 || buf.length > plafond) return null;
  /* Les deux premiers octets d'un JPEG. */
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const refus = await refusCle(request);
  if (refus) return refus;

  const store = galerieStore();
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (url.searchParams.get("liste")) {
      let idx = [];
      try { idx = (await store.get("galeries", { type: "json" })) || []; } catch (e) {}
      /* Les selections recues avant le 20/10/2026 n'ont pas encore leur date
         dans l'index (onglet "A retoucher") : on relit leur galerie une fois. */
      const aRelire = idx.filter(x => x.statut === "choisie" && !x.choisieAt).slice(0, 50);
      if (aRelire.length) {
        for (const x of aRelire) {
          const g = await lireGalerie(store, x.jeton);
          if (g) Object.assign(x, ligneIndex(g));
        }
        try { await store.setJSON("galeries", idx); } catch (e) {}
      }
      /* L'adresse vient d'ici et pas du CRM : c'est MBS_SITE_URL qui la
         decide, comme dans le mail des retouches. */
      return json({ ok: true, galeries: idx.map(x => ({ ...x, adresse: adresseGalerie(x.jeton) })) });
    }
    const g = await lireGalerie(store, normaliserJeton(url.searchParams.get("g")));
    if (!g) return json({ ok: false, error: "introuvable" }, 404);
    return json({ ok: true, galerie: g, adresse: adresseGalerie(g.jeton) });
  }
  if (request.method !== "POST") return json({ ok: false, error: "methode" }, 405);

  let corps = {};
  try { corps = await request.json(); } catch (e) { return json({ ok: false, error: "json" }, 400); }

  /* ---------- creer ---------- */
  if (corps.action === "creer") {
    /* Le nom et l'email viennent de la fiche, jamais du navigateur : la
       galerie et ses messages ne peuvent partir qu'a une vraie cliente. */
    let client = null;
    try {
      const data = await loadData(crmStore());
      client = (data.clients || []).find(c => c.id === String(corps.clientId || ""));
    } catch (e) {}
    if (!client) return json({ ok: false, error: "client" }, 404);
    const mots = String(client.name || "").trim().split(/\s+/);
    const r = await creerGalerie(store, {
      clientId: client.id, prenom: mots[0] || "", nom: mots.slice(1).join(" "),
      email: client.email || "", formule: String(corps.formule || ""), seance: corps.seance,
      formules: corps.formules, quota: corps.quota,
      transfert: corps.transfert, transferts: corps.transferts, photos: corps.photos
    });
    if (r.erreur) return json({ ok: false, error: r.erreur }, 400);
    return json({ ok: true, jeton: r.galerie.jeton, photos: r.galerie.photos,
                  adresse: adresseGalerie(r.galerie.jeton) });
  }

  const g = await lireGalerie(store, normaliserJeton(corps.g));
  if (!g) return json({ ok: false, error: "introuvable" }, 404);

  /* ---------- images ----------
     Envoyees par petits paquets, et l'une apres l'autre : la liste des
     photos recues se met a jour sans course entre deux envois. */
  if (corps.action === "images") {
    const items = Array.isArray(corps.items) ? corps.items.slice(0, IMAGES_PAR_ENVOI) : [];
    const connues = new Set(g.photos.map(p => p.id));
    const recues = new Set(g.recues || []), refusees = [];
    for (const it of items) {
      const id = String((it && it.id) || "");
      if (!idPhotoValide(id) || !connues.has(id)) { refusees.push(id); continue; }
      const t = image(it.t, POIDS_MAX_VIGNETTE), v = image(it.v, POIDS_MAX_APERCU);
      if (!t || !v) { refusees.push(id); continue; }
      await store.set("t-" + g.jeton + "-" + id, t);
      await store.set("v-" + g.jeton + "-" + id, v);
      recues.add(id);
      /* Le format de la photo (largeur / hauteur), mesure par le CRM : la
         galerie compose ses rangees des l'ouverture, portraits en portrait,
         paysages en paysage, sans attendre les miniatures. */
      const r = Number(it.r);
      if (r > 0.2 && r < 5) { const ph = g.photos.find(p => p.id === id); if (ph) ph.r = Math.round(r * 1000) / 1000; }
    }
    g.recues = g.photos.map(p => p.id).filter(id => recues.has(id));
    await enregistrer(store, g);
    return json({ ok: true, recues: g.recues.length, total: g.photos.length, refusees });
  }

  /* ---------- la seconde seance ----------
     Les photos de la naissance, ajoutees a la galerie de la grossesse.
     Cachees a la cliente jusqu'a "publier". */
  if (corps.action === "ajouter-seance") {
    const r = ajouterSeance(g, { seance: corps.seance, transfert: corps.transfert, photos: corps.photos });
    if (r.erreur) return json({ ok: false, error: r.erreur }, 400);
    await enregistrer(store, g);
    return json({ ok: true, photos: r.photos, adresse: adresseGalerie(g.jeton) });
  }

  /* ---------- publier ----------
     La galerie entiere la premiere fois ; ensuite, une seance ajoutee. Si
     la cliente avait deja valide son choix, il est range avec ses
     retouches, et elle choisit la suite avec ce qui lui reste. */
  if (corps.action === "publier") {
    const manquent = g.photos.filter(p => !(g.recues || []).includes(p.id)).map(p => p.nom);
    if (manquent.length) return json({ ok: false, error: "incomplete", manquent: manquent.slice(0, 20),
                                        nbManquent: manquent.length }, 409);
    const now = Date.now();
    const etaitEnLigne = g.statut !== "preparation";
    if (!etaitEnLigne) { g.statut = "envoyee"; g.envoyeeAt = now; }
    const nouvelles = (g.seances || []).filter(x => !x.prete);
    nouvelles.forEach(x => { x.prete = true; x.at = now; });
    const range = etaitEnLigne && nouvelles.length ? nouveauChoix(g) : false;
    await enregistrer(store, g);
    return json({ ok: true, adresse: adresseGalerie(g.jeton), seances: nouvelles.map(x => x.cle), range });
  }

  /* ---------- le total de retouches comprises ----------
     Matt offre des photos : 15 + 5 offertes = 20. Jamais moins que ce que
     les choix precedents ont deja pris. */
  if (corps.action === "quota") {
    const q = quotaSaisi(corps.quota);
    if (q == null || Number.isNaN(q)) return json({ ok: false, error: "quota" }, 400);
    const pris = (g.passees || []).reduce((a, t) => a + comprisesDe(g, t), 0);
    if (q && q < pris) return json({ ok: false, error: "deja_pris", pris }, 400);
    g.quota = q;
    await enregistrer(store, g);
    return json({ ok: true, quota: q });
  }

  /* ---------- le lien "tout telecharger" ----------
     Un WeTransfer expire vite : Matt doit pouvoir en coller un nouveau
     sans refaire la galerie. */
  if (corps.action === "transfert") {
    const l = lienValide(corps.lien);
    if (corps.lien && !l) return json({ ok: false, error: "lien" }, 400);
    /* Galerie a deux seances : un lien par seance. */
    if (g.seances) {
      const x = g.seances.find(y => y.cle === String(corps.seance || ""));
      if (!x) return json({ ok: false, error: "seance" }, 400);
      x.transfert = l;
    } else g.transfert = l;
    await enregistrer(store, g);
    return json({ ok: true });
  }

  /* ---------- les retouches ---------- */
  if (corps.action === "retouches") {
    const l = lienValide(corps.lien);
    if (!l) return json({ ok: false, error: "lien" }, 400);
    /* tour : un choix precedent (galerie a deux seances), par son rang dans
       g.passees. Sans tour : le choix en cours. */
    const tour = corps.tour === undefined || corps.tour === null || corps.tour === "" ? null : Number(corps.tour);
    if (tour !== null) {
      const t = Number.isInteger(tour) ? (g.passees || [])[tour] : null;
      if (!t) return json({ ok: false, error: "tour" }, 400);
      t.retouches = l; t.retouchesAt = Date.now();
    } else {
      g.retouches = l;
      g.statut = "retouchee";
      g.retouchesAt = Date.now();
    }
    await enregistrer(store, g);
    let envoye = false;
    if (corps.prevenir && g.email && String(corps.texte || "").trim()) {
      let avis = AVIS_MBS_DEFAUT;
      try { const data = await loadData(crmStore()); avis = lienValide((data.reglages || {}).avisMybabyshoot) || AVIS_MBS_DEFAUT; } catch (e) {}
      const html = htmlRetouches(corps.texte, { retouches: l, galerie: adresseGalerie(g.jeton), avis });
      try { envoye = await sendMail({ to: g.email, subject: "Vos photos retouchées sont prêtes", html }); }
      catch (e) { envoye = false; }
    } else if (corps.prevenir && g.email) {
      /* Un CRM pas encore mis a jour n'envoie pas de texte : l'ancien mail. */
      const html =
        "<p>Bonjour " + esc(g.prenom) + " !</p>" +
        "<p>Vos photos retouchées sont prêtes.</p>" +
        '<p style="margin:24px 0"><a href="' + esc(l) + '" style="background:#5E4430;color:#FFFFFF;' +
        'padding:14px 28px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:bold">' +
        "Télécharger mes photos retouchées</a></p>" +
        "<p>Vous les retrouvez aussi dans votre galerie, avec toutes les autres :<br>" +
        '<a href="' + esc(adresseGalerie(g.jeton)) + '">' + esc(adresseGalerie(g.jeton)) + "</a></p>" +
        "<p>Le lien de téléchargement a une durée limitée : pensez à enregistrer vos photos.</p>" +
        "<p>Matteo<br>Mybabyshoot · 06 47 76 54 17</p>";
      try { envoye = await sendMail({ to: g.email, subject: "Vos photos retouchées sont prêtes", html }); }
      catch (e) { envoye = false; }
    }
    return json({ ok: true, envoye });
  }

  /* ---------- la photo de couverture ----------
     Choisie par Matt dans le CRM. Vide : la galerie prend la premiere photo
     en paysage. */
  if (corps.action === "couverture") {
    const id = String(corps.id || "");
    if (id && !(idPhotoValide(id) && g.photos.some(p => p.id === id))) return json({ ok: false, error: "photo" }, 400);
    /* Galerie a deux seances : une photo par seance, prise dans SES photos.
       L'ancienne couverture unique, si elle etait de cette seance, s'efface :
       sinon "revenir au choix automatique" la remettrait. */
    if (g.seances && corps.seance) {
      const cle = String(corps.seance);
      if (!g.seances.some(x => x.cle === cle)) return json({ ok: false, error: "seance" }, 400);
      if (id && (g.photos.find(p => p.id === id) || {}).s !== cle) return json({ ok: false, error: "photo" }, 400);
      g.couvertures = { ...(g.couvertures || {}) };
      if (id) g.couvertures[cle] = id; else delete g.couvertures[cle];
      if (g.couverture && (g.photos.find(p => p.id === g.couverture) || {}).s === cle) g.couverture = "";
      await enregistrer(store, g);
      return json({ ok: true, couvertures: g.couvertures });
    }
    g.couverture = id;
    await enregistrer(store, g);
    return json({ ok: true, couverture: id });
  }

  /* ---------- supprimer ---------- */
  if (corps.action === "supprimer") {
    await supprimerGalerie(store, g);
    return json({ ok: true });
  }

  return json({ ok: false, error: "action" }, 400);
};

export const config = { path: "/.netlify/functions/mbs-galerie-admin" };
