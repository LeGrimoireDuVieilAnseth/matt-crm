// netlify/functions/mbs-galerie-admin.js
// La galerie legere, cote CRM (protege par CRM_KEY, voir mbs-garde.mjs).
//
//   GET  ?liste=1                                  : les galeries
//   GET  ?g=JETON                                  : une galerie, selection comprise
//   POST {action:"creer", clientId, formule, seance, transfert, photos:[{nom}]}
//   POST {action:"images", g, items:[{id, t, v}]}  : vignettes et apercus, en base64
//   POST {action:"publier", g}                     : la galerie devient visible
//   POST {action:"transfert", g, lien}             : remplacer le lien "tout telecharger"
//   POST {action:"retouches", g, lien, prevenir}   : le lien des photos retouchees
//   POST {action:"supprimer", g}
//
// Les images arrivent DEJA allegees par le navigateur de Matt. Ici on ne
// fait que les ranger, en refusant ce qui est trop lourd pour etre un
// apercu : une photo en pleine qualite deposee par erreur couterait de la
// bande passante a chaque ouverture.
import { galerieStore, creerGalerie, lireGalerie, enregistrer, supprimerGalerie, lienValide,
         normaliserJeton, idPhotoValide, POIDS_MAX_VIGNETTE, POIDS_MAX_APERCU, IMAGES_PAR_ENVOI } from "../mbs-galeries.mjs";
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
      return json({ ok: true, galeries: idx });
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
      transfert: corps.transfert, photos: corps.photos
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
    }
    g.recues = g.photos.map(p => p.id).filter(id => recues.has(id));
    await enregistrer(store, g);
    return json({ ok: true, recues: g.recues.length, total: g.photos.length, refusees });
  }

  /* ---------- publier ---------- */
  if (corps.action === "publier") {
    const manquent = g.photos.filter(p => !(g.recues || []).includes(p.id)).map(p => p.nom);
    if (manquent.length) return json({ ok: false, error: "incomplete", manquent: manquent.slice(0, 20),
                                        nbManquent: manquent.length }, 409);
    if (g.statut === "preparation") { g.statut = "envoyee"; g.envoyeeAt = Date.now(); }
    await enregistrer(store, g);
    return json({ ok: true, adresse: adresseGalerie(g.jeton) });
  }

  /* ---------- le lien "tout telecharger" ----------
     Un WeTransfer expire vite : Matt doit pouvoir en coller un nouveau
     sans refaire la galerie. */
  if (corps.action === "transfert") {
    const l = lienValide(corps.lien);
    if (corps.lien && !l) return json({ ok: false, error: "lien" }, 400);
    g.transfert = l;
    await enregistrer(store, g);
    return json({ ok: true });
  }

  /* ---------- les retouches ---------- */
  if (corps.action === "retouches") {
    const l = lienValide(corps.lien);
    if (!l) return json({ ok: false, error: "lien" }, 400);
    g.retouches = l;
    g.statut = "retouchee";
    g.retouchesAt = Date.now();
    await enregistrer(store, g);
    let envoye = false;
    if (corps.prevenir && g.email) {
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

  /* ---------- supprimer ---------- */
  if (corps.action === "supprimer") {
    await supprimerGalerie(store, g);
    return json({ ok: true });
  }

  return json({ ok: false, error: "action" }, 400);
};

export const config = { path: "/.netlify/functions/mbs-galerie-admin" };
