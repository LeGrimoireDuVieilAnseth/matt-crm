// netlify/mbs-paiement-panier.mjs
/* La session Stripe d'un panier de complements.

   Partagee par le lien de paiement (mbs-lien) et par la galerie
   (mbs-galerie) : une commande passee depuis la galerie DEVIENT un lien de
   paiement, et suit ensuite le meme chemin jusqu'au bout (webhook, facture,
   ligne de recette, rappel des tirages). Il n'y a donc qu'une facon de
   presenter un panier a Stripe, et surtout une seule application de la
   regle du moyen de paiement unique : la carte a cote de Klarna fait
   s'ouvrir l'ecran Link par-dessus, et la cliente ne trouve plus Klarna.

   Le detail du panier ne voyage pas dans les metadonnees, limitees a 500
   caracteres par champ : il est garde dans le lien, attache a la session
   (memoriserPanier), et c'est lui que la facture reprend. */
import { resumePanier } from "./mbs-panier.mjs";

export async function ouvrirSessionPanier(stripe, { lien, panier, troisFois, site, retourOk, retourAnnule }) {
  /* Une ligne Stripe par ligne du panier : la cliente retrouve le detail
     sur l'ecran de paiement et sur son recu, pas seulement un total. */
  const line_items = panier.lignes.map(l => ({
    quantity: 1,
    price_data: {
      currency: "eur",
      unit_amount: Math.round(l.montant * 100),
      product_data: {
        name: String(l.libelle).slice(0, 250),
        ...(l.detail ? { description: String(l.detail).slice(0, 250) } : {})
      }
    }
  }));

  return stripe.checkout.sessions.create({
    mode: "payment",
    /* Un seul moyen par page, celui qu'elle vient de choisir : proposer
       la carte a cote de Klarna ferait s'ouvrir l'ecran Link par-dessus.
       Meme regle que sur les reservations et les bons cadeaux. */
    payment_method_types: troisFois ? ["klarna"] : ["card"],
    customer_email: lien.email || undefined,
    line_items,
    success_url: retourOk,
    cancel_url: retourAnnule,
    metadata: {
      app: "mbs-lien", lienCode: lien.code,
      clientId: lien.clientId || "", montant: String(panier.total),
      /* Le detail complet vit dans le lien, attache a cette session :
         les metadonnees Stripe sont limitees a 500 caracteres par champ. */
      libelle: resumePanier(panier).slice(0, 480),
      prenom: lien.prenom || "", nom: lien.nom || "",
      email: lien.email || "", site
    }
  });
}
