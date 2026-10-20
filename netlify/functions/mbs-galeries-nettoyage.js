// netlify/functions/mbs-galeries-nettoyage.js
// Le menage des galeries legeres, chaque nuit.
//
// Une galerie vit trois mois (choix de Matt), puis ses vignettes et ses
// apercus sont effaces. C'est ce qui borne le stockage, et donc ce que la
// galerie coute chez Netlify. Les originaux, eux, ne sont jamais ici : ils
// restent chez Matt.
//
// Fonction planifiee : Netlify l'appelle seul, elle n'est pas joignable
// depuis l'exterieur.
import { galerieStore, lireGalerie, supprimerGalerie, estExpiree } from "../mbs-galeries.mjs";

/* Au plus quelques galeries par nuit : une fonction planifiee dispose de
   quelques dizaines de secondes. Celles qui restent passent la nuit
   suivante. */
const PAR_NUIT = 6;

export default async () => {
  const store = galerieStore();
  const now = Date.now();
  let idx = [];
  try { idx = (await store.get("galeries", { type: "json" })) || []; } catch (e) {}
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
  return new Response(JSON.stringify({ ok: true, effacees, restantes: Math.max(0,
    idx.filter(x => x.expiresAt && now > x.expiresAt).length - effacees) }),
    { headers: { "Content-Type": "application/json" } });
};

// chaque nuit a 4 h UTC, apres la sauvegarde de 3 h
export const config = { schedule: "0 4 * * *" };
