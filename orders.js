// Commandes d'exemple et générateur aléatoire, calqués sur les commandes déjà connues de l'IHM.
//
// Ce que l'on reprend de l'IHM (samples/commande_27800403.xml / .json, commande_27800511) :
//  - numéros de commande à 8 chiffres en 278xxxxx ;
//  - références à 8 chiffres, familles 10xxxxxx (majoritaire), 20xxxxxx et 30xxxxxx ;
//  - emplacements « allée-colonne » au format A-01 (lettre, tiret, 2 chiffres) ;
//  - quantités faibles (1 à 6 en général), parfois une grappe ou un carton complet ;
//  - grappes de 2, 4, 5, 6 ou 10 ; carton = 4 à 10 grappes (20 à 100 pièces).
// Une même référence garde toujours le même emplacement et le même conditionnement
// (données article), y compris d'une commande générée à l'autre.

export const CATALOG = {
  "10724824": { location: "A-03", qty_per_box: 20, qty_per_grappe: 2 },
  "10531207": { location: "B-11", qty_per_box: 40, qty_per_grappe: 5 },
  "20994312": { location: "C-07", qty_per_box: 24, qty_per_grappe: 4 },
  "10388650": { location: "A-14", qty_per_box: 36, qty_per_grappe: 6 },
  "30117042": { location: "D-02", qty_per_box: 60, qty_per_grappe: 10 },
};

function line(reference, quantity) {
  return { reference_number: reference, quantity_to_pick: quantity, ...CATALOG[reference] };
}

// Mêmes commandes que l'IHM (samples/*.json) — vérifié par tests/orders.test.mjs.
export const SAMPLE_ORDERS = [
  {
    order_number: "27800403",
    references: [line("10724824", 2), line("10531207", 5), line("20994312", 1), line("10388650", 3),
      line("30117042", 4)],
  },
  { order_number: "27800511", references: [line("10724824", 1), line("20994312", 2)] },
];

const FAMILIES = [["10", 0.6], ["20", 0.25], ["30", 0.15]];
const GRAPPES = [2, 4, 5, 6, 10];
const GRAPPES_PER_BOX = [4, 5, 6, 8, 10];
const AISLES = "ABCDEF";
const MAX_QUANTITY = 30; // une impulsion capteur par pièce : on reste testable à la main

/** Données article stables pour une référence (catalogue connu, sinon dérivées de son numéro). */
export function articleData(reference) {
  if (CATALOG[reference]) return { ...CATALOG[reference] };
  const h = fnv1a(reference);
  const grappe = GRAPPES[(h >>> 8) % GRAPPES.length];
  return {
    location: `${AISLES[h % AISLES.length]}-${String(1 + ((h >>> 3) % 24)).padStart(2, "0")}`,
    qty_per_box: grappe * GRAPPES_PER_BOX[(h >>> 13) % GRAPPES_PER_BOX.length],
    qty_per_grappe: grappe,
  };
}

/** Commande aléatoire réaliste (2 à 8 références, triées dans l'ordre du parcours). */
export function generateRandomOrder(random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const reserved = new Set(SAMPLE_ORDERS.map((o) => o.order_number));
  let orderNumber;
  do {
    orderNumber = `278${String(600 + Math.floor(random() * 99400)).padStart(5, "0")}`;
  } while (reserved.has(orderNumber));

  const count = 2 + Math.floor(random() * 7);
  const used = new Set();
  const references = [];
  while (references.length < count) {
    const known = Object.keys(CATALOG).filter((r) => !used.has(r));
    const reference = known.length && random() < 0.35 ? pick(known) : randomReference(random);
    if (used.has(reference)) continue;
    used.add(reference);
    const article = articleData(reference);
    references.push({ reference_number: reference, quantity_to_pick: randomQuantity(article, random),
      ...article });
  }
  references.sort((a, b) => a.location.localeCompare(b.location)); // parcours A-01 -> F-24
  return { order_number: orderNumber, references };
}

function randomReference(random) {
  let roll = random();
  let family = FAMILIES[FAMILIES.length - 1][0];
  for (const [prefix, weight] of FAMILIES) {
    if (roll < weight) {
      family = prefix;
      break;
    }
    roll -= weight;
  }
  return family + String(Math.floor(random() * 1_000_000)).padStart(6, "0");
}

function randomQuantity(article, random) {
  const roll = random();
  let quantity;
  if (roll < 0.65) quantity = 1 + Math.floor(random() * 6); // quelques pièces
  else if (roll < 0.92) quantity = article.qty_per_grappe * (1 + Math.floor(random() * 2)); // 1-2 grappes
  else quantity = article.qty_per_box; // un carton complet
  return Math.min(quantity, MAX_QUANTITY);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Générateur pseudo-aléatoire reproductible (tests). */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
