// netlify/functions/crm-idees.js
// Le bouton "Ranger mes idees" du pense-bete.
//
// Une idee dictee en voiture arrive brute : une phrase longue, parfois
// deux sujets melanges, souvent sans ponctuation. Relire trente notes
// pareilles decourage, et un pense-bete qu'on ne relit pas ne sert a
// rien. Claude leur donne un titre court, propose une premiere action
// concrete, et signale celles qui parlent de la meme chose.
//
// A LA DEMANDE, JAMAIS AUTOMATIQUE : chaque appel coute quelques
// centimes, et Matt doit garder la main sur ce qu'il depense.
//
// Il ne REMPLACE jamais le texte d'origine : il ajoute un titre et une
// action a cote. Une reformulation automatique finirait par effacer ce
// que Matt voulait vraiment dire.
//
// Protege par le mot de passe du CRM (CRM_KEY). Cle Anthropic dans
// ANTHROPIC_API_KEY, cote Netlify.
import Anthropic from "@anthropic-ai/sdk";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

function autorise(request) {
  const attendu = process.env.CRM_KEY || "";
  if (!attendu) return true;
  return (request.headers.get("x-crm-key") || "") === attendu;
}

const CONSIGNE = `Tu ranges le pense-bete d'un photographe francais, Matteo, qui dicte
ses idees a la voix entre deux seances. Ses trois activites : Mybabyshoot
(grossesse et naissance), Maison Lumiere (mariage) et Matt la photo.

Pour chaque idee, rends :
- "titre" : 6 mots maximum, ce que l'idee dit vraiment. Pas de ponctuation
  finale. C'est ce que Matteo lira dans une liste, ca doit suffire a se
  rappeler de quoi il s'agit sans ouvrir.
- "action" : la premiere chose concrete a faire, 12 mots maximum, qui
  commence par un verbe a l'infinitif. Si l'idee n'appelle aucune action
  (une simple note, une observation), laisse une chaine vide.

Rends aussi "groupes" : les rapprochements utiles entre idees, une phrase
chacun, au maximum trois. Ne dis rien si tu ne vois rien : un rapprochement
force fait perdre du temps. N'invente aucun conseil de gestion, contente-toi
de ce que les idees contiennent.

Ecris en francais, sans tiret long ni tiret moyen.

Reponds UNIQUEMENT avec un objet JSON de cette forme, sans texte autour :
{"idees":[{"id":"...","titre":"...","action":"..."}],"groupes":["..."]}`;

export default async (request) => {
  if (!autorise(request)) return json({ ok: false, erreur: "non autorise" }, 401);
  if (request.method !== "POST") return json({ ok: false, erreur: "methode refusee" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ ok: false, message: "La clé Anthropic n'est pas configurée sur Netlify." }, 503);
  }

  let corps;
  try { corps = await request.json(); }
  catch (e) { return json({ ok: false, erreur: "json" }, 400); }
  if (corps.action !== "ranger") return json({ ok: false, erreur: "action inconnue" }, 400);

  /* On borne l'envoi : trente idees suffisent largement a un rangement, et
     ca garde le cout previsible meme si le pense-bete deborde un jour. */
  const idees = (Array.isArray(corps.idees) ? corps.idees : [])
    .filter(i => i && i.id && String(i.texte || "").trim())
    .slice(0, 30)
    .map(i => ({ id: String(i.id).slice(0, 40), texte: String(i.texte).trim().slice(0, 1200) }));
  if (!idees.length) return json({ ok: false, message: "Aucune idée à ranger." }, 400);

  try {
    const client = new Anthropic();
    /* On s'en tient aux parametres que le SDK installe accepte a coup sur :
       package.json epingle "^0.88.0", et sur une version 0.x le caret ne
       monte pas au-dela de 0.88.x. Les parametres recents (output_config,
       thinking explicite, fallbacks) risqueraient d'etre refuses par cette
       version. Ce n'est pas une perte : sur Claude Opus 5, ne pas passer
       "thinking" fait tourner la reflexion adaptative par defaut.
       Le jour ou le SDK sera remonte, on pourra ajouter effort:"low" pour
       diviser la depense sur une tache aussi simple. */
    const reponse = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: CONSIGNE,
      messages: [{ role: "user", content: JSON.stringify({ idees }) }],
    });

    if (reponse.stop_reason === "refusal") {
      return json({ ok: false, message: "Claude n'a pas pu traiter ces idées." }, 502);
    }

    const texte = (reponse.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("").trim();

    /* Le modele repond parfois avec l'objet entoure d'un peu de texte : on
       decoupe sur les accolades plutot que d'echouer pour si peu. */
    let data = null;
    try { data = JSON.parse(texte); }
    catch (e) {
      const a = texte.indexOf("{"), b = texte.lastIndexOf("}");
      if (a >= 0 && b > a) { try { data = JSON.parse(texte.slice(a, b + 1)); } catch (_) {} }
    }
    if (!data || !Array.isArray(data.idees)) {
      return json({ ok: false, message: "Réponse illisible, rien n'a été modifié." }, 502);
    }

    /* On ne renvoie que des id que le CRM a bien envoyes : une reponse ne
       doit jamais pouvoir toucher a une idee qui n'etait pas du lot. */
    const connus = new Set(idees.map(i => i.id));
    const propres = data.idees
      .filter(x => x && connus.has(String(x.id)))
      .map(x => ({
        id: String(x.id),
        titre: String(x.titre || "").trim().slice(0, 90),
        action: String(x.action || "").trim().slice(0, 140),
      }));

    const groupes = (Array.isArray(data.groupes) ? data.groupes : [])
      .slice(0, 3).map(g => String(g).trim().slice(0, 220)).filter(Boolean);

    return json({ ok: true, idees: propres, groupes });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return json({ ok: false, message: "Trop de demandes d'un coup, réessaie dans une minute." }, 429);
    }
    if (e instanceof Anthropic.AuthenticationError) {
      return json({ ok: false, message: "La clé Anthropic est refusée." }, 502);
    }
    return json({ ok: false, message: String((e && e.message) || e) }, 500);
  }
};
