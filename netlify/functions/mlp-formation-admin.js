// netlify/functions/mlp-formation-admin.js
// La formation "Oser", cote CRM (Reglages > Formation Matt la Photo).
// Protege par la cle du CRM.
//
//   POST {action:"etat"}                 : reglages, lecons, codes vendus ou offerts
//   POST {action:"ouvrir", ouverte}      : ouvrir ou fermer la vente
//   POST {action:"presentation", video, format} : la video en haut de la page de vente
//   POST {action:"lecons", lecons}       : enregistrer les lecons
//   POST {action:"offrir", note}         : un code gratuit (collab, ami)
//   POST {action:"retirer", email}       : retirer l'acces (remboursement)
import { FORMATION, SESSIONS_MAX, afficherCode, lireReglages, ecrireReglages, lireLecons, ecrireLecons,
         leconsPropres, presentationPropre, offrirCode, retirerAcces, listeCodes } from "../mlp-formation.mjs";
import { cleCRM, statutRefus } from "../mbs-garde.mjs";
import { marqueDe } from "../marques.mjs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

export default async (request) => {
  const etatCle = await cleCRM(request);
  if (etatCle !== "ok") return json({ ok: false, error: etatCle }, statutRefus(etatCle));
  if (request.method !== "POST") return json({ ok: false }, 405);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = String(body.action || "");
  const m = marqueDe("matt-la-photo");

  if (action === "etat") {
    const codes = (await listeCodes()).map(c => ({
      code: afficherCode(c.code), statut: c.statut, source: c.source, email: c.email || "", compte: c.compte || "",
      note: c.note || "", montant: c.montant || 0, at: c.at || 0, utiliseLe: c.utiliseLe || 0, retire: !!c.retire
    }));
    return json({ ok: true, nom: FORMATION.nom, prix: FORMATION.prix, appareils: SESSIONS_MAX,
      reglages: await lireReglages(), lecons: await lireLecons(), codes,
      paiement: !!m.stripeSecret(), mail: !!(process.env.MLP_SMTP_USER && process.env.MLP_SMTP_PASS),
      adresse: m.site() + "/formation.html" });
  }

  if (action === "ouvrir") {
    const r = await lireReglages();
    r.ouverte = body.ouverte === true;
    await ecrireReglages(r);
    return json({ ok: true, reglages: r });
  }

  if (action === "presentation") {
    const p = presentationPropre(body);
    if (!p) return json({ ok: false, error: "video" }, 400);
    const r = await lireReglages();
    r.presentation = p;
    await ecrireReglages(r);
    return json({ ok: true, reglages: r });
  }

  if (action === "lecons") {
    const l = leconsPropres(body.lecons);
    if (!l) return json({ ok: false, error: "video" }, 400);
    await ecrireLecons(l);
    return json({ ok: true, lecons: l });
  }

  if (action === "offrir") {
    const code = await offrirCode({ note: body.note || "" });
    return json({ ok: true, code: afficherCode(code), adresse: m.site() + "/cours.html#code=" + code });
  }

  if (action === "retirer") {
    const fait = await retirerAcces(body.email);
    return json({ ok: fait }, fait ? 200 : 404);
  }

  return json({ ok: false, error: "action" }, 400);
};
