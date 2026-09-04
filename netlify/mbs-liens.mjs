// netlify/mbs-liens.mjs
// Les liens de paiement : un montant a regler, envoye a une cliente par
// SMS ou par mail.
//
// A QUOI CA SERT
// Une cliente arrive avec un bon cadeau pour la formule a 290 euros et
// veut passer a celle du dessus. Il manque 100 euros. Plutot que de lui
// demander un virement, Matt lui envoie un lien.
//
// POURQUOI UN CODE ET PAS UNE SESSION STRIPE
// Une session Stripe expire au bout de 24 heures, c'est une limite de
// Stripe. Un lien envoye par SMS un vendredi soir serait mort le samedi.
// On stocke donc un code, et la page du site cree la session au moment
// ou la cliente clique. Le lien ne perime jamais.
//
// LE MONTANT NE VIENT JAMAIS DU NAVIGATEUR
// Il est lu ici, dans le stockage, a chaque fois. Une adresse trafiquee
// ne peut donc pas changer le prix.
import { getStore } from "@netlify/blobs";
import { makeCode } from "./mbs-coupons.mjs";

export const LIEN_STORE = "mbs-liens";

/* Garde-fous sur le montant. Le plancher evite les liens a 1 euro crees
   par erreur, le plafond attrape la faute de frappe qui ajoute un zero. */
export const LIEN_MIN = 10;
export const LIEN_MAX = 3000;

/* Au-dessus de ce montant, le paiement en 3 fois est propose. En dessous,
   il n'a pas de sens : etaler 60 euros sur trois mois est plus penible
   qu'utile. */
export const LIEN_SEUIL_3X = 150;

export function lienStore() {
  return getStore({ name: LIEN_STORE, consistency: "strong" });
}

export function normaliserCode(brut) {
  return String(brut || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function montantValide(v) {
  const n = Math.round(Number(String(v).replace(",", ".")));
  if (!Number.isFinite(n) || n < LIEN_MIN || n > LIEN_MAX) return null;
  return n;
}

/* Ce que la page publique a le droit de savoir. Surtout pas l'email ni le
   nom de famille : le lien peut etre transfere, ou lu par-dessus l'epaule. */
export function vuePublique(l) {
  return {
    code: l.code,
    libelle: l.libelle || "Complément",
    montant: l.montant,
    prenom: l.prenom || "",
    statut: l.statut,
    troisFois: l.montant >= LIEN_SEUIL_3X,
  };
}

export async function creerLien(store, { clientId, prenom, nom, email, montant, libelle, now = Date.now() }) {
  let code = "";
  for (let i = 0; i < 8; i++) {
    const essai = makeCode(8);
    const deja = await store.get("l-" + essai, { type: "json" }).catch(() => null);
    if (!deja) { code = essai; break; }
  }
  if (!code) return null;

  const lien = {
    code, clientId: String(clientId || ""),
    prenom: String(prenom || "").slice(0, 40),
    nom: String(nom || "").slice(0, 80),
    email: String(email || "").slice(0, 120),
    montant, libelle: String(libelle || "").slice(0, 120),
    statut: "attente",
    createdAt: now, paidAt: 0, sessionId: "", invoiceNumber: "",
  };
  await store.setJSON("l-" + code, lien);

  try {
    const idx = (await store.get("liens", { type: "json" })) || [];
    idx.unshift({ code, clientId: lien.clientId, nom: lien.nom, montant, libelle: lien.libelle,
                  statut: "attente", createdAt: now });
    await store.setJSON("liens", idx.slice(0, 300));
  } catch (e) {}

  return lien;
}

/* L'index sert la liste du CRM. Sans cette mise a jour, un lien paye
   continuerait d'y apparaitre comme en attente. */
export async function majIndex(store, code, champs) {
  try {
    const idx = (await store.get("liens", { type: "json" })) || [];
    const e = idx.find(x => x.code === code);
    if (e) { Object.assign(e, champs); await store.setJSON("liens", idx); }
  } catch (e) {}
}
