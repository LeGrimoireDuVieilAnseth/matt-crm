// netlify/functions/mbs-sauvegarde-auto.js
// Sauvegarde automatique des donnees du CRM, chaque nuit.
// Fonction planifiee : Netlify l'appelle seul, elle n'est pas joignable
// depuis l'exterieur (c'est mbs-sauvegardes qui sert a les recuperer).
import { sauvegarder } from "../mbs-sauvegarde.mjs";

export default async () => {
  const r = await sauvegarder();
  return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
};

// chaque nuit a 3 h UTC
export const config = { schedule: "0 3 * * *" };
