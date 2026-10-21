// netlify/functions/mbs-checkout.js
// Cree une session Stripe Checkout pour l'acompte d'une reservation Mybabyshoot.
// Pose d'abord un verrou anti-doublon sur le creneau (un seul client par creneau).
// La cle secrete Stripe est lue dans l'environnement Netlify (STRIPE_SECRET_KEY),
// jamais dans le code.
import Stripe from "stripe";
import {
  crmStore, loadData, pruneLocks, isFree, isValidSlot,
  acompteFor, typeLabelFr, typeConnu, prixSeance, GAMMES_DUO, LOCK_TTL_MS, COUPON_TTL_MS,
  uid, BRAND, PLACE
} from "../mbs-lib.mjs";
import { prixTirages } from "../mbs-panier.mjs";
import {
  couponStore, checkCoupon, reasonLabel, discountFor,
  reserveCoupon, releaseCoupon, consumeCoupon, prettyGift
} from "../mbs-coupons.mjs";
import { calculerDeplacement } from "../mbs-deplacement.mjs";
import { porteFermee, noterEchec, LIMITE_CODES, MESSAGE_TROP_CODES } from "../mbs-garde.mjs";
import { notifyAll } from "../push-lib.mjs";
import { sendMail } from "../mbs-mail.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
});

function frDate(iso) {
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

/* Bon cadeau couvrant la totalite : il n'y a aucun paiement en ligne, donc pas
   de webhook Stripe. On enregistre nous-memes la reservation dans le CRM,
   on brule le bon, on previent Matt et on confirme au client. */
async function confirmerSansPaiement({ store, lockId, now, md }) {
  const data = await loadData(store);
  pruneLocks(data, now);

  const typeLbl = typeLabelFr(md.type);
  const name = [md.prenom, md.nom].filter(Boolean).join(" ").trim() || "Client Mybabyshoot";
  const email = (md.email || "").trim();
  const tel   = (md.tel || "").trim();

  let client = data.clients.find(c =>
    c.brand === BRAND &&
    ((email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
     (tel && c.tel && c.tel.replace(/\s/g, "") === tel.replace(/\s/g, "")))
  );
  if (!client) {
    client = {
      id: uid(), brand: BRAND, name, status: "Client", type: typeLbl,
      tel, email, insta: "", source: "Bon cadeau",
      notes: "", fromSite: true, createdAt: now
    };
    data.clients.push(client);
  } else {
    client.tel = client.tel || tel;
    client.email = client.email || email;
    client.status = "Client";
  }

  /* Un code de RESERVATION n'est pas un bon cadeau : la seance a deja ete
     payee dans le pack. On enregistre la seance, et AUCUNE ligne de
     paiement : en creer une ferait compter le pack deux fois dans le
     tableau de bord des ventes. */
  const estResa = md.kind === "reservation";
  const detail = estResa
    ? "Code de réservation " + prettyGift(md.coupon) + (md.formule ? " (" + md.formule + ")" : "") + "."
    : "Bon cadeau " + prettyGift(md.coupon) + " (-" + md.remise + " €, séance " + md.totalPlein + " €).";

  data.seances.push({
    id: uid(), clientId: client.id, brand: BRAND, type: typeLbl,
    date: md.date, time: md.time, place: PLACE, status: "A venir",
    notes: estResa
      ? "Seconde séance du pack, déjà réglée. La cliente a choisi son créneau elle-même avec son code. "
        + detail + " Rien à encaisser."
      : "Réservation en ligne réglée avec un bon cadeau. " + detail + " Rien à encaisser le jour J.",
    createdAt: now, giftCode: md.coupon
  });
  if (!estResa) data.paiements.push({
    id: uid(), brand: BRAND, clientId: client.id,
    label: "Séance réglée par bon cadeau",
    total: String(md.totalPlein), acompte: String(md.totalPlein), statut: "Solde",
    date: new Date(now).toISOString().slice(0, 10), dueDate: md.date,
    notes: detail + " Déjà payé par l'acheteur du bon.",
    giftCode: md.coupon
  });

  /* Le pack ne bloque qu'un creneau, celui de la grossesse. Quand il est
     offert, rien ne passe par Stripe : le webhook, qui pose d'habitude ce
     rappel, n'est jamais appele. Sans ces lignes, la seconde seance ne
     tiendrait qu'a la memoire de Matt, dans le cas le plus frequent. */
  if (md.type === "duo") {
    data.taches = data.taches || [];
    data.taches.push({
      id: uid(), done: false,
      title: "Caler la séance naissance — " + name,
      dueDate: md.date,
      priority: "Haute", clientId: client.id,
      notes: "Pack grossesse + naissance réglé par bon cadeau."
        + (md.formule ? "\n" + md.formule + "." : "")
        + "\n\nÀ faire le jour de la séance grossesse : convenir avec elle"
        + " qu'elle prévienne dès la naissance, pour caler la séance"
        + " dans les 10 jours qui suivent.",
      giftCode: md.coupon
    });
  }

  data.mbsLocks = data.mbsLocks.filter(l => l.id !== lockId);
  data.t = now;
  await store.setJSON("data", data);

  // Le bon est brule maintenant : la seance est confirmee.
  try { await consumeCoupon(couponStore(), md.coupon, "cadeau-" + md.date + "-" + md.time, now); } catch (e) {}

  try {
    await notifyAll(
      estResa ? "Seconde séance calée" : "Nouvelle réservation (bon cadeau)",
      name + " · " + typeLbl + " le " + frDate(md.date) + " à " + md.time + " · rien à encaisser",
      "/"
    );
  } catch (e) {}

  if (email) {
    const site = md.site || "https://mybabyshoot.fr";
    const html =
      "<p>Bonjour " + (md.prenom || "") + " !</p>" +
      (estResa
        ? "<p>C'est noté, votre seconde séance est réservée.</p>"
        : "<p>Tout d'abord, j'espère que ce cadeau vous fait plaisir !</p>") +
      "<p>Votre réservation est bien confirmée.</p>" +
      "<ul>" +
      "<li><b>Séance :</b> " + typeLbl + "</li>" +
      "<li><b>Date :</b> " + frDate(md.date) + " à " + md.time + "</li>" +
      "<li><b>Lieu :</b> " + PLACE + "</li>" +
      // Reglee par un bon cadeau : on ne parle ni de reglement ni de solde,
      // la personne n'a rien a payer et n'a pas a revoir le code ici.
      "</ul>" +
      "<p>Au plaisir de vous rencontrer !</p>" +
      "<p>Si vous avez des questions, appelez-moi ou échangeons sur WhatsApp au 06 47 76 54 17.</p>" +
      "<p>Mybabyshoot · <a href=\"" + site + "\">" + site.replace(/^https?:\/\//, "") + "</a></p>";
    await sendMail({ to: email, subject: "Votre réservation est confirmée · Mybabyshoot", html });
  }
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ ok: false, error: "stripe_not_configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  let   type   = String(body.type || "grossesse");
  /* Liste fermee : un type inconnu arriverait etiquete "Grossesse" dans le
     CRM et sur la facture, sans que personne s'en apercoive. */
  if (!typeConnu(type)) {
    return json({ ok: false, error: "type",
      message: "Type de séance non reconnu. Rechargez la page et recommencez." }, 400);
  }
  /* Le pack deux seances : une formule par seance. Liste fermee, comme pour
     le type : une valeur inconnue ferait echouer le calcul du prix plus bas,
     autant la refuser ici avec un message lisible. */
  let paireDuo = "";
  if (body.section === "duo" && body.gammes) {
    const g = String(body.gammes.grossesse || ""), n = String(body.gammes.naissance || "");
    if (!GAMMES_DUO.includes(g) || !GAMMES_DUO.includes(n)) {
      return json({ ok: false, error: "formule",
        message: "Formule du pack non reconnue. Rechargez la page et recommencez." }, 400);
    }
    paireDuo = g + "+" + n;
  }
  // Provenance de la visite, telle que le site l'a retenue. Liste fermee :
  // on n'ecrit dans la fiche que des categories connues.
  const ORIGINES = ["Google Ads", "Google", "Instagram", "TikTok", "Facebook", "Autre moteur", "Autre site", "Direct"];
  const origine = ORIGINES.includes(String(body.origine || "")) ? String(body.origine) : "Direct";
  /* Comment la cliente veut regler. Liste fermee : tout ce qui n'est pas
     "integral" retombe sur l'acompte, le mode par defaut. */
  const integral = String(body.paiement || "") === "integral";
  const date   = String(body.date || "");
  const time   = String(body.time || "");
  const client = body.client || {};
  const prenom = String(client.prenom || "").trim();
  const nom    = String(client.nom || "").trim();
  const email  = String(client.email || "").trim();
  const tel    = String(client.tel || "").trim();

  if (!isValidSlot(date, time)) return json({ ok: false, error: "invalid_slot" }, 400);
  if (!prenom || !email) return json({ ok: false, error: "missing_client" }, 400);

  /* Prix de la seance : recalcule ICI a partir de la formule choisie. Le
     navigateur envoie aussi ce qu'il a affiche, mais uniquement pour qu'on
     puisse detecter un ecart : jamais pour facturer.

     Une reservation avec un bon cadeau seul ne passe pas par le
     configurateur, sa formule vient du bon et non du navigateur. */
  let total = 0, affiche = null;
  /* Un lien a prix convenu (reserver.html) n'envoie pas de formule : elle
     est dans le code, comme pour un bon cadeau. */
  if (!body.giftOnly && !body.surMesure) {
    const calcule = prixSeance({
      section: body.section, gamme: body.gamme, gammes: body.gammes,
      photos: body.photos, album: body.album, tirages: body.tirages
    });
    if (calcule === null) {
      return json({ ok: false, error: "formule",
        message: "Formule non reconnue. Rechargez la page et recommencez la réservation." }, 400);
    }
    total = calcule;
    const vu = Math.round(Number(body.totalAffiche));
    if (Number.isFinite(vu)) affiche = vu;
  } else if (!body.coupon) {
    /* Une reservation "bon cadeau seul" tire son montant du bon. Sans code,
       le total resterait a zero et la seance serait confirmee gratuitement.
       Avant, la fourchette de securite l'empechait par accident ; maintenant
       qu'elle a disparu, il faut le dire explicitement. */
    return json({ ok: false, error: "coupon",
      message: "Indiquez le code de votre bon cadeau." }, 400);
  }

  const store = crmStore();
  const now = Date.now();
  let totalPlein = total;

  // Site reellement utilise par le visiteur : sert aux liens des emails et
  // aux retours Stripe. Calcule ici car les deux chemins (paiement, et bon
  // cadeau couvrant toute la seance) en ont besoin.
  const origin = request.headers.get("origin") || "";
  const site = (process.env.MBS_SITE_URL || origin || "https://mybabyshoot.fr").replace(/\/+$/, "");

  // 1) Verrou anti-doublon : on relit, on nettoie les verrous expires, on verifie le creneau.
  const data = await loadData(store);
  pruneLocks(data, now);
  if (!isFree(data, date, time, now)) {
    // Un autre paiement est en cours ou le creneau est deja pris.
    await store.setJSON("data", data); // on persiste au moins le nettoyage des verrous expires
    return json({ ok: false, error: "slot_taken" }, 409);
  }
  const lockId = uid();
  data.mbsLocks.push({ id: lockId, date, time, expiresAt: now + LOCK_TTL_MS });
  await store.setJSON("data", data);

  const releaseLock = async () => {
    try {
      const d2 = await loadData(store);
      d2.mbsLocks = d2.mbsLocks.filter(l => l.id !== lockId);
      await store.setJSON("data", d2);
    } catch (_) {}
  };

  // 1bis) Code de reduction ou bon cadeau : verifie ET applique cote serveur
  //       (jamais depuis le navigateur). Le code est seulement reserve ici ;
  //       il n'est consomme qu'au paiement confirme.
  let remise = 0, couponCode = "", couponKind = "promo", giftFormule = "", acompteImpose = null, gammeCode = "";
  if (body.coupon) {
    const cstore = couponStore();
    /* Essais rates limites par adresse. Sans cette limite, on pouvait
       essayer les combinaisons une par une jusqu'a tomber sur un bon
       cadeau ou un code de reservation valable, et reserver sans payer. */
    if (await porteFermee("codes", request, LIMITE_CODES)) {
      await releaseLock();
      return json({ ok: false, error: "coupon", message: MESSAGE_TROP_CODES }, 429);
    }
    const chk = await checkCoupon(cstore, body.coupon, now);
    if (!chk.ok) {
      if (chk.reason === "inconnu") await noterEchec("codes", request, LIMITE_CODES);
      await releaseLock();
      return json({ ok: false, error: "coupon", message: reasonLabel(chk.reason) }, 400);
    }
    couponKind = chk.coupon.kind === "cadeau" ? "cadeau"
               : chk.coupon.kind === "reservation" ? "reservation"
               : chk.coupon.kind === "surmesure" ? "surmesure" : "promo";

    /* Lien a prix convenu : la seance, la formule, le montant final et
       l'acompte viennent du code, que Matt a cree dans le CRM. Le
       navigateur ne decide de rien : ni options, ni deplacement. La remise
       est l'ecart avec la grille, pour que la fiche et la facture montrent
       le tarif, le geste, et ce qui reste. */
    if (couponKind === "surmesure") {
      const c = chk.coupon;
      type = typeConnu(c.seance) ? c.seance : "grossesse";
      if (type === "duo" && c.gammes) { paireDuo = c.gammes.grossesse + "+" + c.gammes.naissance; giftFormule = paireDuo; }
      else { gammeCode = String(c.gamme || ""); giftFormule = gammeCode; }
      const plein = Number(c.plein) || Number(c.total) || 0;
      const fixe = Math.min(Number(c.total) || 0, plein);
      total = plein; totalPlein = plein; remise = Math.max(0, plein - fixe);
      acompteImpose = Math.max(1, Math.min(Number(c.acompte) || 0, fixe));
      body.photos = 0; body.album = false; body.tirages = {}; body.exterieur = null;
    }

    /* Code de reservation : la seance a DEJA ete reglee, c'est la seconde
       d'un pack. Rien a prelever, et surtout rien a recompter en recette :
       une ligne de paiement ferait compter le pack deux fois dans le
       tableau de bord des ventes. */
    if (couponKind === "reservation") {
      total = 0; totalPlein = 0;
      const s = chk.coupon.seance;
      type = typeConnu(s) ? s : "naissance";
      giftFormule = String(chk.coupon.formule || "");
    }

    // Reservation faite AVEC un bon cadeau seul : la prestation et sa valeur
    // viennent du bon, jamais du navigateur (la personne ne choisit que sa date).
    if (couponKind === "cadeau" && body.giftOnly) {
      const val = Number(chk.coupon.amount);
      if (Number.isFinite(val) && val > 0) { total = val; totalPlein = val; }
      /* Le type vient du bon, et la liste fermee fait foi : sans bebe ni
         famille ici, un bon bebe entrait dans le CRM, dans l'email de
         confirmation et sur la facture en "Grossesse". */
      const s = chk.coupon.seance;
      type = typeConnu(s) ? s : "grossesse";
      /* La formule inscrite sur le bon, pour la fiche et pour le rappel de
         la seconde seance quand le bon couvre un pack. */
      giftFormule = String(chk.coupon.formule || "");
    }

    /* Un code de reservation ne porte pas de remise : il n'y a deja plus
       rien a payer. Le controle ci-dessous ne vaut que pour les deux
       autres genres. */
    if (couponKind !== "reservation" && couponKind !== "surmesure") {
      remise = discountFor(total, chk.coupon.amount, couponKind);
      if (remise <= 0) {
        await releaseLock();
        return json({ ok: false, error: "coupon", message: "Ce code ne s'applique pas à cette formule." }, 400);
      }
    }
    /* Le code, et non le creneau : il tient plus longtemps, sinon deux
       personnes pourraient utiliser le meme bon. */
    const pose = await reserveCoupon(cstore, chk.code, now + COUPON_TTL_MS);
    if (!pose) {
      await releaseLock();
      return json({ ok: false, error: "coupon", message: "Ce code vient d'être utilisé." }, 409);
    }
    couponCode = chk.code;
    total = total - remise;
  }

  /* Acompte calcule sur le prix PLEIN (avant remise) : Matt encaisse le meme
     acompte qu'une reservation sans code, c'est le solde du jour J qui baisse.
     Garde-fou : l'acompte ne depasse jamais le total a payer.

     En paiement integral, il n'y a plus d'acompte : on prend tout. Le solde
     du jour J tombe a zero. */
  const acompte = integral ? total
    : acompteImpose !== null ? Math.min(acompteImpose, total)   // fixe par Matt (lien a prix convenu)
    : Math.min(acompteFor(totalPlein), total);

  // Seance en exterieur : les frais sont RECALCULES ici depuis l'adresse.
  // Le navigateur n'envoie qu'une adresse, jamais un montant. Les frais
  // s'ajoutent APRES la remise : un code promo ne doit pas manger le carburant.
  let fraisDepl = 0, lieuExt = "";
  if (body.exterieur && body.exterieur.adresse) {
    const d = await calculerDeplacement(String(body.exterieur.adresse).slice(0, 160));
    if (!d.ok) {
      await releaseLock();
      if (couponCode) { try { await releaseCoupon(couponStore(), couponCode); } catch (_) {} }
      return json({ ok: false, error: "exterieur", message: "Adresse du lieu non reconnue. Reprenez l'adresse dans le formulaire." }, 400);
    }
    fraisDepl = d.frais;
    lieuExt = d.label;
    total += fraisDepl;
  }

  /* Ce que la cliente a vu doit couvrir ce qu'on va lui compter. Si son
     ecran annonce moins, c'est que la page est perimee ou que le montant a
     ete bricole : on refuse plutot que de facturer plus que l'affichage.
     L'inverse ne pose pas de probleme, elle paie moins que prevu.

     total + remise, c'est le prix de la formule plus le deplacement, avant
     remise : exactement ce que le site affiche a l'ecran. */
  if (affiche !== null && affiche < total + remise) {
    await releaseLock();
    if (couponCode) { try { await releaseCoupon(couponStore(), couponCode); } catch (_) {} }
    return json({ ok: false, error: "prix",
      message: "Nos tarifs ont changé depuis l'ouverture de la page. Rechargez-la pour voir le prix à jour." }, 409);
  }

  // Cas bon cadeau couvrant toute la seance : plus rien a payer en ligne.
  // Stripe ne sait pas encaisser 0 euro, on confirme donc la reservation ici.
  if (total <= 0) {
    try {
      await confirmerSansPaiement({
        store, lockId, now,
        md: {
          type, date, time, prenom, nom, email, tel, site,
          coupon: couponCode, remise: String(remise), totalPlein: String(totalPlein),
          formule: giftFormule, kind: couponKind
        }
      });
      return json({ ok: true, gratuit: true });
    } catch (e) {
      await releaseLock();
      if (couponCode) { try { await releaseCoupon(couponStore(), couponCode); } catch (_) {} }
      return json({ ok: false, error: "server", detail: String(e && e.message || e) }, 500);
    }
  }

  // 2) Session Stripe Checkout pour l'acompte.
  try {
    const stripe = new Stripe(secret);
    const label = (integral ? "Séance " : "Acompte réservation ") + typeLabelFr(type);

    /* Les tirages papier commandes des la reservation, sous une forme
       courte : "20x30:2,40x60:1". Les metadonnees Stripe plafonnent a 500
       caracteres par champ, et le webhook n en a pas besoin de plus pour
       reconstituer la commande a partir de la grille.
       Au moment de reserver, les photos n existent pas encore : ni numeros
       ni adresse. Matt les reclamera apres la seance, et le webhook lui
       pose un rappel pour ca. */
    const tiragesTexte = prixTirages(body.tirages).lignes
      .map(l => l.cle + ":" + l.quantite).join(",");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      /* Klarna n'est propose que sur le paiement integral. Sur un acompte de
         90 EUR, fractionner n'aurait aucun sens et couterait plus cher.
         Apple Pay et Google Pay n'ont pas a etre listes : sur les pages
         hebergees par Stripe, ils sont servis par le type "card".

         KLARNA SEUL SUR LE 3 FOIS, ET C'EST DELIBERE.
         La cliente vient de cliquer "Tout regler, en 3 fois avec Klarna".
         Tant que "card" figurait aussi dans cette liste, Stripe ouvrait sa
         page sur Link, son paiement enregistre : il fallait comprendre
         qu'on demande une adresse email pour un service dont on n'a jamais
         entendu parler, puis deviner qu'il faut cliquer "payer autrement"
         pour enfin voir Klarna. Des clientes s'y perdaient, rappelaient, ou
         abandonnaient. On ne peut pas demander a quelqu'un de choisir deux
         fois la meme chose.
         Contrepartie assumee : si Klarna refuse le dossier, il n'y a pas de
         repli par carte sur cet ecran. La cliente revient en arriere et
         prend l'acompte, qui lui est toujours propose. */
      payment_method_types: integral ? ["klarna"] : ["card"],
      customer_email: email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: acompte * 100,
          product_data: {
            name: label,
            description: "Séance du " + frDate(date) + " à " + time +
              (lieuExt ? " en extérieur, " + lieuExt + "." : " au studio, à La Mulatière.")
          }
        }
      }],
      // valeur : le prix complet de la seance, pas l'acompte. C'est ce que
      // la vente rapporte vraiment, et c'est la-dessus que Google doit
      // apprendre a optimiser.
      success_url: site + "/?reservation=ok&valeur=" + total + (integral ? "&integral=1" : "") + "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: couponKind === "surmesure" && couponCode
        ? site + "/reserver.html?c=" + couponCode + "&annule=1"   // elle retrouve sa page, pas le configurateur
        : site + "/?reservation=annulee",
      // La relance part quand Stripe declare la session expiree. Matt la veut
      // le lendemain a la meme heure : Stripe plafonne a 24 h, on prend une
      // petite marge pour ne pas se faire refuser a la seconde pres.
      expires_at: Math.floor(now / 1000) + 23 * 60 * 60 + 55 * 60,
      metadata: {
        app: "mybabyshoot", lockId, type, date, time, site,
        lieuExt, fraisDepl: String(fraisDepl),
        acompte: String(acompte), total: String(total), origine,
        integral: integral ? "1" : "",
        coupon: couponCode, remise: String(remise), totalPlein: String(totalPlein),
        /* Ce qu'elle a commande en papier, sous une forme courte : les
           metadonnees Stripe sont limitees a 500 caracteres par champ. */
        tirages: tiragesTexte,
        /* La formule et les options, pour que la facture puisse detailler.
           Des identifiants et des quantites, jamais des montants : les
           prix se retrouvent cote serveur, dans la grille. */
        gamme: gammeCode || String(body.gamme || ""),
        /* Le genre du code : le webhook ecrit "prix convenu" et non "code
           promo" pour un lien de Matt. */
        kind: couponCode ? couponKind : "",
        photos: String(Math.min(Math.max(parseInt(body.photos, 10) || 0, 0), 50)),
        album: body.album ? "1" : "",
        /* La formule de chaque seance du pack, "confort+prestige". Sans
           elle, le CRM afficherait un total et Matt ne saurait pas combien
           de photos retoucher, ni pour laquelle des deux seances. */
        duo: paireDuo,
        prenom, nom, email, tel
      }
    });

    return json({ ok: true, url: session.url });
  } catch (e) {
    // Echec Stripe : on relache le verrou et le code promo pour ne rien bloquer.
    try {
      const d2 = await loadData(store);
      d2.mbsLocks = d2.mbsLocks.filter(l => l.id !== lockId);
      await store.setJSON("data", d2);
    } catch (_) {}
    if (couponCode) { try { await releaseCoupon(couponStore(), couponCode); } catch (_) {} }
    return json({ ok: false, error: "stripe_error", detail: String(e && e.message || e) }, 502);
  }
};

export const config = { path: "/.netlify/functions/mbs-checkout" };
