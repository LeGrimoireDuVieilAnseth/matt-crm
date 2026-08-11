// netlify/mbs-deplacement.mjs
// Frais de deplacement pour les seances en exterieur.
//
// Le studio est a La Mulatiere. Matt offre le deplacement dans un rayon de
// 20 km ; au-dela, on facture le carburant de l'aller-retour.
//
// Adresses geocodees avec l'API officielle des adresses francaises
// (api-adresse.data.gouv.fr) : gratuite, sans cle, precise en France.

/* ---------- Reglages : tout se change ici ---------- */
export const STUDIO = { lat: 45.72309, lon: 4.80384 };  // 16 chemin du Buisset, La Mulatiere
export const RAYON_OFFERT_KM = 20;      // deplacement offert jusqu'a cette distance
export const PRIX_CARBURANT   = 2;      // euros le litre
export const CONSO_L_100KM    = 7;      // consommation moyenne du vehicule
export const PEAGE_PAR_KM     = 0.10;   // peage moyen sur autoroute francaise
export const CHARGES          = 0.25;   // 25 % de charges (URSSAF) sur le total
export const FACTEUR_ROUTE    = 1.3;    // vol d'oiseau -> distance reelle par la route
export const DISTANCE_MAX_KM  = 200;    // au-dela, on invite a appeler plutot qu'a reserver

const API = "https://api-adresse.data.gouv.fr/search/";

/* Distance a vol d'oiseau entre deux points, en kilometres. */
function volDoiseau(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* Frais de l'aller-retour : carburant + peages, puis les charges.
   Le rayon est OFFERT seulement si tout le trajet tient dedans ; au-dela,
   c'est la totalite du trajet qui est comptee, pas seulement le depassement.
   Arrondi a l'euro superieur. Le peage est une moyenne au kilometre :
   le trajet reel peut ne pas en comporter. Se change en haut de ce fichier. */
export function fraisPour(km) {
  if (km <= RAYON_OFFERT_KM) return 0;
  const kmAllerRetour = km * 2;
  const carburant = (kmAllerRetour * CONSO_L_100KM / 100) * PRIX_CARBURANT;
  const peages    = kmAllerRetour * PEAGE_PAR_KM;
  return Math.ceil((carburant + peages) * (1 + CHARGES));
}

/* Retrouve une adresse francaise. On privilegie les resultats proches de
   Lyon, sinon "Vienne" tombe dans la Haute-Vienne. */
export async function geocoder(adresse) {
  const q = String(adresse || "").trim();
  if (q.length < 3) return null;
  const url = API + "?limit=1&lat=" + STUDIO.lat + "&lon=" + STUDIO.lon +
              "&q=" + encodeURIComponent(q);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mybabyshoot (site de reservation)" } });
    if (!r.ok) return null;
    const j = await r.json();
    const f = (j.features || [])[0];
    if (!f || !f.geometry || !f.geometry.coordinates) return null;
    return {
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: String(f.properties.label || q).slice(0, 120),
      ville: String(f.properties.city || "").slice(0, 60),
      score: Number(f.properties.score) || 0
    };
  } catch (e) { return null; }
}

/* Distance reelle par la route, en kilometres, via un service de calcul
   d'itineraire ouvert. Retourne null si le service ne repond pas : on se
   rabat alors sur l'estimation a vol d'oiseau, pour ne jamais bloquer une
   reservation a cause d'un service tiers. */
const ROUTAGE = "https://router.project-osrm.org/route/v1/driving/";

async function distanceRoutiere(lat, lon) {
  try {
    const url = ROUTAGE + STUDIO.lon + "," + STUDIO.lat + ";" + lon + "," + lat + "?overview=false";
    const ctrl = new AbortController();
    const stop = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(stop);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.code !== "Ok" || !j.routes || !j.routes[0]) return null;
    return {
      km: Math.round(j.routes[0].distance / 1000),
      minutes: Math.round(j.routes[0].duration / 60)
    };
  } catch (e) { return null; }
}

/* Calcul complet a partir d'une adresse saisie.
   Retourne { ok, label, km, minutes, estime, frais, offert } ou { ok:false, raison }. */
export async function calculerDeplacement(adresse) {
  const lieu = await geocoder(adresse);
  if (!lieu) return { ok: false, raison: "introuvable" };
  if (lieu.score < 0.4) return { ok: false, raison: "imprecis" };

  const route = await distanceRoutiere(lieu.lat, lieu.lon);
  const km = route ? route.km
                   : Math.round(volDoiseau(STUDIO.lat, STUDIO.lon, lieu.lat, lieu.lon) * FACTEUR_ROUTE);
  const minutes = route ? route.minutes : 0;

  if (km > DISTANCE_MAX_KM) return { ok: false, raison: "trop_loin", km, label: lieu.label };

  const frais = fraisPour(km);
  return {
    ok: true, label: lieu.label, ville: lieu.ville,
    km, minutes, estime: !route,
    frais, offert: frais === 0
  };
}
