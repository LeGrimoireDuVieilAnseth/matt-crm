// netlify/functions/mbs-galeries-nettoyage.js
// Le menage des galeries legeres, chaque nuit.
//
// Une galerie vit six mois (choix de Matt, trois jusqu'au 05/11/2026), puis
// ses vignettes et ses apercus sont effaces. C'est ce qui borne le stockage,
// et donc ce que la galerie coute chez Netlify. Les originaux, eux, ne sont
// jamais ici : ils restent chez Matt.
//
// Fonction planifiee : Netlify l'appelle seul, elle n'est pas joignable
// depuis l'exterieur.
import { galerieStore, lireGalerie, supprimerGalerie, estExpiree, enregistrer, finDeVie } from "../mbs-galeries.mjs";

/* Au plus quelques galeries par nuit : une fonction planifiee dispose de
   quelques dizaines de secondes. Celles qui restent passent la nuit
   suivante. */
const PAR_NUIT = 6;
const PROLONGEES_PAR_NUIT = 25;
const UN_JOUR = 86400000;
const ANCIENNE_DUREE_MOIS = 3;
/* Une galerie creee sous l'ancienne regle : sa fin tombe pile trois mois
   apres sa creation. Seules celles-la sont prolongees : une fin fixee
   autrement (a la main, un jour) n'est jamais touchee. */
const aLAncienneRegle = (createdAt, expiresAt) =>
  Math.abs(expiresAt - finDeVie(createdAt, ANCIENNE_DUREE_MOIS)) < 2 * UN_JOUR;

export default async () => {
  const store = galerieStore();
  const now = Date.now();
  let idx = [];
  try { idx = (await store.get("galeries", { type: "json" })) || []; } catch (e) {}

  /* Passage de trois a six mois (05/11/2026) : les galeries creees avant
     gardaient leur fin a trois mois. On la repousse AVANT d'effacer quoi
     que ce soit, y compris pour une galerie qui vient de depasser ses trois
     mois mais n'a pas encore ete effacee. Jamais l'inverse : une fin plus
     lointaine reste telle quelle, une fin plus proche aussi. */
  const aProlonger = idx.filter(x => x.createdAt && x.expiresAt
    && aLAncienneRegle(x.createdAt, x.expiresAt) && finDeVie(x.createdAt) > now)
    .slice(0, PROLONGEES_PAR_NUIT);
  let prolongees = 0;
  for (const ligne of aProlonger) {
    const g = await lireGalerie(store, ligne.jeton);
    if (!g || !g.createdAt) continue;
    const fin = finDeVie(g.createdAt);
    if (!aLAncienneRegle(g.createdAt, g.expiresAt) || !(g.expiresAt < fin)) continue;
    g.expiresAt = fin;
    try { await enregistrer(store, g); prolongees++; } catch (e) {}
  }
  if (prolongees) {
    try { idx = (await store.get("galeries", { type: "json" })) || []; } catch (e) {}
  }

  const expirees = idx.filter(x => x.expiresAt && now > x.expiresAt).slice(0, PAR_NUIT);
  let effacees = 0;
  for (const ligne of expirees) {
    const g = await lireGalerie(store, ligne.jeton);
    if (g && estExpiree(g, now)) { await supprimerGalerie(store, g); effacees++; }
    else if (!g) {
      /* Une ligne d'index sans galerie : on la retire, sinon elle
         reviendrait chaque nuit. */
      try {
        const i2 = (await store.get("galeries", { type: "json" })) || [];
        await store.setJSON("galeries", i2.filter(x => x.jeton !== ligne.jeton));
      } catch (e) {}
    }
  }
  return new Response(JSON.stringify({ ok: true, prolongees, effacees, restantes: Math.max(0,
    idx.filter(x => x.expiresAt && now > x.expiresAt).length - effacees) }),
    { headers: { "Content-Type": "application/json" } });
};

// chaque nuit a 4 h UTC, apres la sauvegarde de 3 h
export const config = { schedule: "0 4 * * *" };
