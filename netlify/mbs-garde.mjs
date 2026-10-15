// netlify/mbs-garde.mjs
/* LA GARDE DES PORTES DU CRM, ET DES CODES.

   Les deux depots GitHub sont publics : n'importe qui peut lire comment le
   mot de passe du CRM est verifie, et comment un code de bon cadeau ou de
   reservation est reconnu. Ce n'est pas un probleme en soi, la securite ne
   repose pas sur le secret du code mais sur celui du mot de passe (qui
   n'est ecrit nulle part dans le depot, ni dans son historique).

   Il y avait en revanche deux defauts, communs aux 14 fonctions protegees :

   1. Elles S'OUVRAIENT si la variable CRM_KEY manquait ("pas encore
      configure"). Une variable effacee par erreur dans Netlify, et toute la
      base clientes devenait lisible par n'importe qui. On refuse desormais.

   2. Rien ne limitait les essais. Il ne manquait que le mot de passe, et
      on pouvait en essayer autant qu'on voulait. Meme chose pour les codes
      de bons cadeaux et de reservation : 6 caracteres, pres de 900 millions
      de combinaisons, mais aucune limite. On compte desormais les echecs
      par adresse, et on ferme la porte a cette adresse un moment.

   L'adresse n'est jamais stockee en clair : on n'en garde qu'une
   empreinte, et seulement quand il y a eu un echec. */
import { getStore } from "@netlify/blobs";

/* Le mot de passe du CRM : 8 essais rates par quart d'heure. Matt se
   trompe rarement plus de deux ou trois fois de suite ; un robot, lui,
   essaie des milliers de fois. */
export const LIMITE_CRM   = { max: 8,  fenetreMs: 15 * 60 * 1000 };
/* Les codes saisis sur le site : 10 essais rates par heure. */
export const LIMITE_CODES = { max: 10, fenetreMs: 60 * 60 * 1000 };

export const MESSAGE_TROP_CRM   = "Trop d'essais. Réessayez dans un quart d'heure.";
export const MESSAGE_TROP_CODES = "Trop d'essais avec des codes inconnus. Réessayez dans une heure, ou appelez le 06 47 76 54 17.";

const magasin = () => getStore({ name: "mbs-garde", consistency: "strong" });

/* L'adresse de la personne, telle que Netlify la transmet. */
export function ipDe(request) {
  return request.headers.get("x-nf-client-connection-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "inconnue";
}

async function cle(porte, request) {
  const b = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(porte + "|" + ipDe(request)));
  return porte + "-" + [...new Uint8Array(b)].slice(0, 12)
    .map(x => x.toString(16).padStart(2, "0")).join("");
}

async function lire(k) {
  try { return await magasin().get(k, { type: "json" }); } catch (e) { return null; }
}

/* La porte est-elle fermee a cette adresse ? */
export async function porteFermee(porte, request, limite) {
  const r = await lire(await cle(porte, request));
  return !!(r && Date.now() - r.debut < limite.fenetreMs && r.n >= limite.max);
}

/* Un echec de plus pour cette adresse. Une seule entree par adresse et par
   porte, remise a zero a chaque nouvelle fenetre : le magasin ne grossit
   pas avec le temps. */
export async function noterEchec(porte, request, limite) {
  const k = await cle(porte, request);
  const now = Date.now();
  let r = await lire(k);
  if (!r || now - r.debut >= limite.fenetreMs) r = { debut: now, n: 0 };
  r.n += 1;
  try { await magasin().setJSON(k, r); } catch (e) {}
}

/* Le controle de la cle du CRM. Renvoie "ok", "refus" ou "bloque".

   - CRM_KEY absente : "refus". Avant, tout s'ouvrait.
   - Adresse bloquee : "bloque", MEME si la cle est bonne. Sinon le robot
     ignorerait le blocage et finirait par tomber sur le bon mot de passe.
   - Aucune cle envoyee : "refus", mais ce n'est pas compte comme un essai.
     Le CRM peut appeler une fonction avant que Matt soit connecte, et ces
     appels ne doivent pas le bloquer lui.

   cleFournie : pour mbs-factures, qui accepte aussi la cle dans l'adresse
   (ouverture d'un PDF dans un nouvel onglet, ou l'on ne peut pas poser
   d'en-tete). */
export async function cleCRM(request, cleFournie) {
  const attendu = process.env.CRM_KEY || "";
  if (!attendu) return "refus";
  if (await porteFermee("crm", request, LIMITE_CRM)) return "bloque";
  const k = cleFournie !== undefined
    ? String(cleFournie || "")
    : (request.headers.get("x-crm-key") || "");
  if (!k) return "refus";
  if (k === attendu) return "ok";
  await noterEchec("crm", request, LIMITE_CRM);
  return "refus";
}

/* Le statut HTTP d'un refus. Un blocage repond 429 et JAMAIS 401 : le CRM
   efface la cle enregistree sur le telephone quand il recoit un 401, et
   Matt devrait alors retaper un mot de passe dont il ne se souvient pas
   toujours. */
export const statutRefus = (etat) => (etat === "bloque" ? 429 : 401);
