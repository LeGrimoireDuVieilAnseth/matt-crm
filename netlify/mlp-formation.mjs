// netlify/mlp-formation.mjs
/* LA FORMATION "OSER" DE MATT LA PHOTO (24/10/2026).

   Une formation en ligne sur la timidite (oser parler, oser aborder, oser
   tout court), vendue sur mattlaphoto.netlify.app.

   LA REGLE DE MATT : chacun paie son acces et recoit un code UNIQUE. Ce
   code ne sert qu'une fois, a creer son compte ; ensuite on entre avec son
   mail et son mot de passe, et le code est perime. Personne ne peut donc
   se passer le meme code : le deuxieme qui le tape trouve "deja utilise".

   Pour qu'un compte ne se prete pas non plus a toute une classe, il ne
   tient ouvert que sur SESSIONS_MAX appareils a la fois : une connexion de
   plus ferme la plus ancienne.

   OU VIT QUOI
   Tout est dans le store "mlp-formation", jamais dans le CRM (data) :
     vente-<session Stripe>  la vente et son code (cree une seule fois)
     code-<CODE>             le code : libre, puis utilise (perime)
     compte-<empreinte mail> le compte : mail, mot de passe (empreinte
                             scrypt, jamais en clair), appareils connectes
     jeton-<empreinte>       un appareil connecte
     reinit-<empreinte>      un lien "mot de passe oublie" (1 heure)
     lecons, reglages        ce que Matt regle depuis le CRM
   Les jetons et les liens ne sont gardes que sous forme d'empreinte : une
   lecture du store ne donne acces a aucun compte.

   LE CODE D'UNE VENTE EST CALCULE, PAS TIRE AU HASARD
   Deux chemins le demandent : le webhook Stripe (qui l'envoie par mail) et
   la page de remerciement (qui l'affiche tout de suite, le webhook pouvant
   arriver apres elle). S'il etait tire au hasard, les deux pourraient en
   creer un chacun a la meme seconde. Il est donc derive de la session
   Stripe par une empreinte a cle secrete : les deux chemins tombent sur le
   meme, et personne ne peut le deviner sans la cle. */
import { getStore } from "@netlify/blobs";
import { createHmac, createHash, randomBytes, scrypt as scryptRappel, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptRappel);

export const FORMATION = {
  nom: "Oser",
  /* Le prix, en euros, decide par Matt le 24/10/2026. Le serveur fait foi :
     la page ne l'envoie jamais. */
  prix: 49,
  libelle: "Formation « Oser » : accès en ligne"
};
/* Appareils connectes en meme temps sur un compte (telephone et ordinateur). */
export const SESSIONS_MAX = 2;
export const MDP_MIN = 8;
const PREFIXE = "OSER";
const REINIT_MS = 60 * 60 * 1000;
export const LECONS_MAX = 60;

export const formationStore = () => getStore({ name: "mlp-formation", consistency: "strong" });

/* Ni 0 ni O, ni 1 ni I : un code se recopie depuis un mail, parfois a la
   main. 32 signes : un octet modulo 32 ne favorise aucune lettre. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const signes = (octets, n) => { let s = ""; for (let i = 0; i < n; i++) s += ALPHABET[octets[i] % 32]; return s; };
const empreinte = (s) => createHash("sha256").update(String(s)).digest("hex");

async function lire(k) {
  try { return await formationStore().get(k, { type: "json" }); } catch (e) { return null; }
}
const ecrire = (k, v) => formationStore().setJSON(k, v);
async function effacer(k) { try { await formationStore().delete(k); } catch (e) {} }

export const normaliserEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 160);
export const emailValide = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const cleCompte = (email) => "compte-" + empreinte(normaliserEmail(email)).slice(0, 40);

/* Le code se montre OSER-ABCD-2345, il se range sans tirets. On accepte
   qu'il soit tape en minuscules, avec des espaces ou sans tirets. */
export function normaliserCode(brut) {
  return String(brut || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}
export const afficherCode = (c) => c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8, 12);

function cleSecrete() {
  const k = process.env.MLP_FORMATION_SECRET || process.env.CRM_KEY || "";
  if (!k) throw new Error("secret");
  return k;
}
export function codeDeSession(sessionId) {
  const h = createHmac("sha256", cleSecrete()).update("formation|" + sessionId).digest();
  return PREFIXE + signes(h, 8);
}

/* ---------- les ventes et les codes ---------- */

/* Le code d'une vente : cree au premier passage (webhook ou page de
   remerciement, le premier arrive), retrouve ensuite. Un code deja utilise
   n'est jamais remis a "libre", meme si Stripe rejoue l'evenement. */
export async function codePourVente({ sessionId, email, montant }) {
  const kv = "vente-" + sessionId;
  const deja = await lire(kv);
  if (deja) return deja;
  const code = codeDeSession(sessionId);
  const v = { code, sessionId, email: normaliserEmail(email), montant: Number(montant) || 0, at: Date.now(), source: "achat" };
  await ecrire(kv, v);
  if (!(await lire("code-" + code)))
    await ecrire("code-" + code, { code, statut: "libre", email: v.email, sessionId, montant: v.montant, at: v.at, source: "achat" });
  return v;
}
export async function enregistrerVente(v) { await ecrire("vente-" + v.sessionId, v); }

/* Un acces offert par Matt (une collab, un ami) : un code tire au hasard,
   sans paiement, qui marche exactement comme les autres. */
export async function offrirCode({ note = "", email = "" } = {}) {
  for (let i = 0; i < 5; i++) {
    const code = PREFIXE + signes(randomBytes(8), 8);
    if (await lire("code-" + code)) continue;
    await ecrire("code-" + code, { code, statut: "libre", email: normaliserEmail(email), note: String(note).slice(0, 120),
      montant: 0, at: Date.now(), source: "offert" });
    return code;
  }
  throw new Error("code");
}

export const lireCode = (code) => lire("code-" + normaliserCode(code));

/* ---------- les comptes ---------- */

async function empreinteMdp(mdp, sel) {
  return (await scrypt(String(mdp), sel, 32)).toString("hex");
}
async function mdpBon(compte, mdp) {
  const h = Buffer.from(await empreinteMdp(mdp || "", compte.sel), "hex");
  const attendu = Buffer.from(compte.hash || "", "hex");
  return attendu.length === h.length && timingSafeEqual(attendu, h);
}

/* Un appareil de plus. Au-dela de SESSIONS_MAX, le plus ancien est
   deconnecte : il lui faudra retaper son mot de passe. */
async function ouvrirSession(kc, compte) {
  const jeton = randomBytes(24).toString("base64url");
  const h = empreinte(jeton);
  compte.sessions = (compte.sessions || []).concat([{ h, at: Date.now() }]);
  while (compte.sessions.length > SESSIONS_MAX) await effacer("jeton-" + compte.sessions.shift().h);
  await ecrire("jeton-" + h, { kc, at: Date.now() });
  await ecrire(kc, compte);
  return jeton;
}

/* Creer son compte avec son code. Le code passe a "utilise" : il ne
   servira plus a personne. */
export async function activer({ code, email, mdp }) {
  const c = normaliserCode(code);
  const rec = c.length === 12 ? await lire("code-" + c) : null;
  if (!rec) return { ok: false, erreur: "code" };
  if (rec.statut !== "libre") return { ok: false, erreur: "utilise" };
  const em = normaliserEmail(email);
  if (!emailValide(em)) return { ok: false, erreur: "email" };
  if (String(mdp || "").length < MDP_MIN) return { ok: false, erreur: "mdp" };
  const kc = cleCompte(em);
  const existant = await lire(kc);
  /* Cette adresse a deja son acces : le code reste libre, il peut servir a
     quelqu'un d'autre (un achat offert a un proche). */
  if (existant && existant.actif !== false) return { ok: false, erreur: "compte" };

  const sel = randomBytes(16).toString("hex");
  const compte = { email: em, sel, hash: await empreinteMdp(mdp, sel), creeLe: Date.now(), code: c,
    sessions: [], actif: true };
  /* Le code d'abord : c'est lui qui ne doit servir qu'une fois. */
  rec.statut = "utilise"; rec.utiliseLe = Date.now(); rec.compte = em;
  await ecrire("code-" + c, rec);
  const jeton = await ouvrirSession(kc, compte);
  return { ok: true, jeton, email: em };
}

export async function connecter({ email, mdp }) {
  const em = normaliserEmail(email);
  const kc = cleCompte(em);
  const compte = await lire(kc);
  if (!compte || compte.actif === false) {
    /* Meme temps de reponse qu'un mauvais mot de passe : on ne doit pas
       pouvoir deviner quelles adresses ont un compte. */
    await empreinteMdp(mdp || "", "0000000000000000");
    return { ok: false, erreur: "identifiants" };
  }
  if (!(await mdpBon(compte, mdp))) return { ok: false, erreur: "identifiants" };
  return { ok: true, jeton: await ouvrirSession(kc, compte), email: em };
}

/* Le compte derriere un jeton, ou null (jeton inconnu, appareil deconnecte
   par une connexion plus recente, acces retire par Matt). */
export async function compteDuJeton(jeton) {
  const j = String(jeton || "");
  if (j.length < 20 || j.length > 64) return null;
  const h = empreinte(j);
  const s = await lire("jeton-" + h);
  if (!s) return null;
  const compte = await lire(s.kc);
  if (!compte || compte.actif === false || !(compte.sessions || []).some(x => x.h === h)) return null;
  return { kc: s.kc, compte, h };
}

export async function deconnecter(jeton) {
  const r = await compteDuJeton(jeton);
  if (!r) return;
  r.compte.sessions = (r.compte.sessions || []).filter(x => x.h !== r.h);
  await ecrire(r.kc, r.compte);
  await effacer("jeton-" + r.h);
}

/* Mot de passe oublie : un lien valable une heure. null si l'adresse n'a
   pas de compte (la page dit la meme chose dans les deux cas). */
export async function demanderReinit(email) {
  const kc = cleCompte(email);
  const compte = await lire(kc);
  if (!compte || compte.actif === false) return null;
  const t = randomBytes(24).toString("base64url");
  await ecrire("reinit-" + empreinte(t), { kc, exp: Date.now() + REINIT_MS });
  return { t, email: compte.email };
}

/* Nouveau mot de passe : tous les appareils sont deconnectes (c'est souvent
   pour ca qu'on le change), sauf celui-ci. */
export async function reinitialiser({ t, mdp }) {
  const k = "reinit-" + empreinte(String(t || ""));
  const r = await lire(k);
  if (!r || r.exp < Date.now()) return { ok: false, erreur: "lien" };
  if (String(mdp || "").length < MDP_MIN) return { ok: false, erreur: "mdp" };
  const compte = await lire(r.kc);
  if (!compte || compte.actif === false) return { ok: false, erreur: "lien" };
  for (const s of compte.sessions || []) await effacer("jeton-" + s.h);
  compte.sel = randomBytes(16).toString("hex");
  compte.hash = await empreinteMdp(mdp, compte.sel);
  compte.sessions = [];
  await effacer(k);
  return { ok: true, jeton: await ouvrirSession(r.kc, compte), email: compte.email };
}

/* Retirer l'acces (un remboursement) : le compte ne s'ouvre plus. */
export async function retirerAcces(email) {
  const kc = cleCompte(email);
  const compte = await lire(kc);
  if (!compte) return false;
  for (const s of compte.sessions || []) await effacer("jeton-" + s.h);
  compte.sessions = []; compte.actif = false; compte.retireLe = Date.now();
  await ecrire(kc, compte);
  return true;
}

/* ---------- ce que Matt regle depuis le CRM ---------- */

export async function lireReglages() {
  return { ouverte: false, presentation: { video: "", format: "vertical" }, ...((await lire("reglages")) || {}) };
}

/* La video de presentation, en haut de la page de vente (demande de Matt
   le 24/10/2026 : "ma video d'appel a l'action, l'explication de la
   formation"). Publique, sur Vimeo comme les lecons. Verticale par defaut :
   Matt tourne pour TikTok. null = lien qui n'est pas Vimeo. */
export const FORMATS_VIDEO = ["vertical", "horizontal"];
export function presentationPropre({ video, format } = {}) {
  const v = lienVimeo(video);
  if (v === null) return null;
  return { video: v, format: FORMATS_VIDEO.includes(format) ? format : "vertical" };
}
export async function ecrireReglages(r) { await ecrire("reglages", r); }

export async function lireLecons() {
  const l = await lire("lecons");
  return Array.isArray(l) ? l : [];
}
export async function ecrireLecons(l) { await ecrire("lecons", l); }

/* Le lien d'une video Vimeo, tel que Matt le copie, devient l'adresse du
   lecteur. Une video "non repertoriee" a un second morceau (le hash) sans
   lequel elle ne se lit pas : on le garde.
     https://vimeo.com/123456789
     https://vimeo.com/123456789/ab12cd34ef
     https://player.vimeo.com/video/123456789?h=ab12cd34ef
   "" = pas encore de video ; null = lien qui n'est pas un lien Vimeo. */
export function lienVimeo(brut) {
  const s = String(brut || "").trim();
  if (!s) return "";
  let m = s.match(/player\.vimeo\.com\/video\/(\d{5,})(?:[^#]*?[?&]h=([0-9a-f]{6,}))?/i);
  if (!m) m = s.match(/vimeo\.com\/(?:[a-z0-9_\/-]*\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?/i);
  if (!m) return null;
  return "https://player.vimeo.com/video/" + m[1] + (m[2] ? "?h=" + m[2].toLowerCase() : "");
}

/* Les lecons telles que Matt les envoie, nettoyees. Renvoie null si l'une a
   un lien video qui n'est pas Vimeo (le CRM le signale). */
export function leconsPropres(liste) {
  if (!Array.isArray(liste)) return null;
  const out = [];
  for (const l of liste.slice(0, LECONS_MAX)) {
    const titre = String((l && l.titre) || "").trim().slice(0, 120);
    if (!titre) continue;
    const video = lienVimeo(l.video);
    if (video === null) return null;
    const id = /^[a-z0-9]{6,12}$/.test(String(l.id || "")) ? l.id : randomBytes(5).toString("hex");
    out.push({ id, titre, texte: String(l.texte || "").trim().slice(0, 3000), video });
  }
  return out;
}

/* Les codes, pour la liste du CRM. Lu a chaque ouverture du panneau, sans
   index a tenir a jour : deux ventes a la meme seconde ne peuvent pas
   s'effacer l'une l'autre dans une liste. */
export async function listeCodes() {
  const st = formationStore();
  let cles = [];
  try { cles = ((await st.list({ prefix: "code-" })).blobs || []).map(b => b.key).filter(k => k.startsWith("code-")); } catch (e) {}
  const codes = [];
  for (const k of cles) { const c = await lire(k); if (c) codes.push(c); }
  /* Un acces retire se voit dans la liste. */
  for (const c of codes) {
    if (c.compte) { const cp = await lire(cleCompte(c.compte)); if (cp && cp.actif === false) c.retire = true; }
  }
  return codes.sort((a, b) => (b.at || 0) - (a.at || 0));
}
