/**
 * Layer 1 — Top US supplement targets.
 *
 * Targeting list for the most-scanned US supplement SKUs. Each entry is
 * resolved to a real DSLD label via targeted search; the seed script then
 * pulls the label, normalizes UPC, and upserts.
 *
 * DSLD has no barcode lookup endpoint — resolution is always search-first.
 * See lib/sources/dsld.ts and app/api/cron/dsld-sync/route.ts for details.
 *
 * Editing rules:
 *   - `query` goes to DSLD's search-filter endpoint (keyword-weighted).
 *   - `mustMatchKeywords` filters hits by brand + product name tokens so
 *     we don't grab the wrong variant.
 *   - `subcategoryHint` is what we force onto the upsert so the product
 *     groups correctly for recommendations.
 */

export type SupplementTarget = {
  brand: string;
  name: string;
  query: string;
  mustMatchKeywords: string[];
  subcategoryHint?: string;
};

export const TOP_SUPPLEMENT_TARGETS: SupplementTarget[] = [
  // ── Optimum Nutrition ──────────────────────────────────────────────────
  {
    brand: 'Optimum Nutrition',
    name: 'Gold Standard 100% Whey Double Rich Chocolate',
    query: 'optimum nutrition gold standard whey double rich chocolate',
    mustMatchKeywords: ['optimum nutrition', 'gold standard', 'chocolate'],
    subcategoryHint: 'protein',
  },
  {
    brand: 'Optimum Nutrition',
    name: 'Gold Standard 100% Whey Vanilla Ice Cream',
    query: 'optimum nutrition gold standard whey vanilla',
    mustMatchKeywords: ['optimum nutrition', 'gold standard', 'vanilla'],
    subcategoryHint: 'protein',
  },
  {
    brand: 'Optimum Nutrition',
    name: 'Micronized Creatine Powder',
    query: 'optimum nutrition micronized creatine',
    mustMatchKeywords: ['optimum nutrition', 'creatine'],
    subcategoryHint: 'pre_workout',
  },
  {
    brand: 'Optimum Nutrition',
    name: 'Opti-Men Multivitamin',
    query: 'optimum nutrition opti men multivitamin',
    mustMatchKeywords: ['optimum nutrition', 'opti-men'],
    subcategoryHint: 'multivitamin',
  },

  // ── Thorne ─────────────────────────────────────────────────────────────
  {
    brand: 'Thorne',
    name: 'Basic Nutrients 2/Day',
    query: 'thorne basic nutrients 2 day',
    mustMatchKeywords: ['thorne', 'basic nutrients'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Thorne',
    name: 'Magnesium Bisglycinate',
    query: 'thorne magnesium bisglycinate',
    mustMatchKeywords: ['thorne', 'magnesium'],
    subcategoryHint: 'omega',
  },
  {
    brand: 'Thorne',
    name: 'Vitamin D/K2 Liquid',
    query: 'thorne vitamin d k2',
    mustMatchKeywords: ['thorne', 'vitamin d'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Thorne',
    name: 'Creatine',
    query: 'thorne creatine',
    mustMatchKeywords: ['thorne', 'creatine'],
    subcategoryHint: 'pre_workout',
  },

  // ── NOW Foods ──────────────────────────────────────────────────────────
  {
    brand: 'NOW Foods',
    name: 'Magnesium Citrate',
    query: 'now foods magnesium citrate',
    mustMatchKeywords: ['now', 'magnesium citrate'],
  },
  {
    brand: 'NOW Foods',
    name: 'Zinc Picolinate',
    query: 'now foods zinc picolinate',
    mustMatchKeywords: ['now', 'zinc'],
  },
  {
    brand: 'NOW Foods',
    name: 'Vitamin D-3 5000 IU',
    query: 'now foods vitamin d3 5000',
    mustMatchKeywords: ['now', 'vitamin d'],
  },
  {
    brand: 'NOW Foods',
    name: 'Ultra Omega-3',
    query: 'now foods ultra omega 3',
    mustMatchKeywords: ['now', 'omega'],
    subcategoryHint: 'omega',
  },

  // ── Nature Made ────────────────────────────────────────────────────────
  {
    brand: 'Nature Made',
    name: 'Multi for Him',
    query: 'nature made multi for him',
    mustMatchKeywords: ['nature made', 'multi'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Nature Made',
    name: 'Vitamin D3 2000 IU',
    query: 'nature made vitamin d3 2000',
    mustMatchKeywords: ['nature made', 'vitamin d'],
  },
  {
    brand: 'Nature Made',
    name: 'Fish Oil 1200 mg',
    query: 'nature made fish oil 1200',
    mustMatchKeywords: ['nature made', 'fish oil'],
    subcategoryHint: 'omega',
  },
  {
    brand: 'Nature Made',
    name: 'Magnesium 400 mg',
    query: 'nature made magnesium 400',
    mustMatchKeywords: ['nature made', 'magnesium'],
  },

  // ── Centrum ────────────────────────────────────────────────────────────
  {
    brand: 'Centrum',
    name: 'Silver Men 50+',
    query: 'centrum silver men 50',
    mustMatchKeywords: ['centrum', 'silver', 'men'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Centrum',
    name: 'Men Multivitamin',
    query: 'centrum men multivitamin',
    mustMatchKeywords: ['centrum', 'men'],
    subcategoryHint: 'multivitamin',
  },

  // ── Garden of Life ─────────────────────────────────────────────────────
  {
    brand: 'Garden of Life',
    name: 'Raw Organic Perfect Food',
    query: 'garden of life raw organic perfect food',
    mustMatchKeywords: ['garden of life', 'raw organic'],
  },
  {
    brand: 'Garden of Life',
    name: 'Vitamin Code Men',
    query: 'garden of life vitamin code men',
    mustMatchKeywords: ['garden of life', 'vitamin code', 'men'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Garden of Life',
    name: 'Sport Organic Plant-Based Protein',
    query: 'garden of life sport organic plant protein',
    mustMatchKeywords: ['garden of life', 'protein'],
    subcategoryHint: 'protein',
  },
  {
    brand: 'Garden of Life',
    name: 'Dr. Formulated Probiotics Once Daily Men',
    query: 'garden of life dr formulated probiotics men',
    mustMatchKeywords: ['garden of life', 'probiotics', 'men'],
    subcategoryHint: 'probiotic',
  },

  // ── MuscleTech ─────────────────────────────────────────────────────────
  {
    brand: 'MuscleTech',
    name: 'Nitro-Tech Whey Protein',
    query: 'muscletech nitro tech whey protein',
    mustMatchKeywords: ['muscletech', 'nitro-tech'],
    subcategoryHint: 'protein',
  },
  {
    brand: 'MuscleTech',
    name: 'Platinum 100% Creatine',
    query: 'muscletech platinum creatine',
    mustMatchKeywords: ['muscletech', 'creatine'],
    subcategoryHint: 'pre_workout',
  },

  // ── Dymatize ───────────────────────────────────────────────────────────
  {
    brand: 'Dymatize',
    name: 'ISO100 Hydrolyzed Whey Protein',
    query: 'dymatize iso100 whey protein',
    mustMatchKeywords: ['dymatize', 'iso100'],
    subcategoryHint: 'protein',
  },

  // ── Ghost ──────────────────────────────────────────────────────────────
  {
    brand: 'Ghost',
    name: 'Whey Protein',
    query: 'ghost whey protein',
    mustMatchKeywords: ['ghost', 'whey'],
    subcategoryHint: 'protein',
  },
  {
    brand: 'Ghost',
    name: 'Legend Pre-Workout',
    query: 'ghost legend pre workout',
    mustMatchKeywords: ['ghost', 'legend'],
    subcategoryHint: 'pre_workout',
  },

  // ── C4 (Cellucor) ──────────────────────────────────────────────────────
  {
    brand: 'C4',
    name: 'Original Pre-Workout',
    query: 'c4 original pre workout',
    mustMatchKeywords: ['c4', 'pre'],
    subcategoryHint: 'pre_workout',
  },
  {
    brand: 'C4',
    name: 'Ripped Pre-Workout',
    query: 'c4 ripped pre workout',
    mustMatchKeywords: ['c4', 'ripped'],
    subcategoryHint: 'pre_workout',
  },

  // ── BSN ────────────────────────────────────────────────────────────────
  {
    brand: 'BSN',
    name: 'Syntha-6 Whey Protein',
    query: 'bsn syntha 6 protein',
    mustMatchKeywords: ['bsn', 'syntha'],
    subcategoryHint: 'protein',
  },
  {
    brand: 'BSN',
    name: 'N.O.-Xplode Pre-Workout',
    query: 'bsn no xplode pre workout',
    mustMatchKeywords: ['bsn', 'xplode'],
    subcategoryHint: 'pre_workout',
  },

  // ── Nordic Naturals ────────────────────────────────────────────────────
  {
    brand: 'Nordic Naturals',
    name: 'Ultimate Omega',
    query: 'nordic naturals ultimate omega',
    mustMatchKeywords: ['nordic naturals', 'ultimate omega'],
    subcategoryHint: 'omega',
  },
  {
    brand: 'Nordic Naturals',
    name: 'Omega-3',
    query: 'nordic naturals omega 3',
    mustMatchKeywords: ['nordic naturals', 'omega'],
    subcategoryHint: 'omega',
  },

  // ── Life Extension ─────────────────────────────────────────────────────
  {
    brand: 'Life Extension',
    name: 'Two-Per-Day Multivitamin',
    query: 'life extension two per day multivitamin',
    mustMatchKeywords: ['life extension', 'two-per-day'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Life Extension',
    name: 'Super Omega-3',
    query: 'life extension super omega 3',
    mustMatchKeywords: ['life extension', 'omega'],
    subcategoryHint: 'omega',
  },
  {
    brand: 'Life Extension',
    name: 'Magnesium Caps',
    query: 'life extension magnesium caps',
    mustMatchKeywords: ['life extension', 'magnesium'],
  },

  // ── Jarrow Formulas ────────────────────────────────────────────────────
  {
    brand: 'Jarrow Formulas',
    name: 'Jarro-Dophilus EPS Probiotic',
    query: 'jarrow jarro dophilus probiotic',
    mustMatchKeywords: ['jarrow', 'dophilus'],
    subcategoryHint: 'probiotic',
  },
  {
    brand: 'Jarrow Formulas',
    name: 'Methyl B-12',
    query: 'jarrow methyl b12',
    mustMatchKeywords: ['jarrow', 'b-12'],
  },

  // ── Solgar ─────────────────────────────────────────────────────────────
  {
    brand: 'Solgar',
    name: 'Male Multiple',
    query: 'solgar male multiple',
    mustMatchKeywords: ['solgar', 'male'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Solgar',
    name: 'Vitamin D3 5000 IU',
    query: 'solgar vitamin d3 5000',
    mustMatchKeywords: ['solgar', 'vitamin d'],
  },

  // ── Pure Encapsulations ────────────────────────────────────────────────
  {
    brand: 'Pure Encapsulations',
    name: 'O.N.E. Multivitamin',
    query: 'pure encapsulations one multivitamin',
    mustMatchKeywords: ['pure encapsulations', 'one'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Pure Encapsulations',
    name: 'Magnesium Glycinate',
    query: 'pure encapsulations magnesium glycinate',
    mustMatchKeywords: ['pure encapsulations', 'magnesium'],
  },

  // ── MaryRuth / MaryRuth Organics ──────────────────────────────────────
  {
    brand: 'MaryRuth Organics',
    name: 'Liquid Morning Multivitamin',
    query: 'maryruth liquid morning multivitamin',
    mustMatchKeywords: ['maryruth', 'multivitamin'],
    subcategoryHint: 'multivitamin',
  },

  // ── Ritual ─────────────────────────────────────────────────────────────
  {
    brand: 'Ritual',
    name: 'Essential for Men Multivitamin 18+',
    query: 'ritual essential men multivitamin',
    mustMatchKeywords: ['ritual', 'essential', 'men'],
    subcategoryHint: 'multivitamin',
  },

  // ── Onnit ──────────────────────────────────────────────────────────────
  {
    brand: 'Onnit',
    name: 'Total Human',
    query: 'onnit total human',
    mustMatchKeywords: ['onnit', 'total human'],
    subcategoryHint: 'multivitamin',
  },
  {
    brand: 'Onnit',
    name: 'Alpha Brain',
    query: 'onnit alpha brain',
    mustMatchKeywords: ['onnit', 'alpha brain'],
  },

  // ── Ashwagandha leaders ────────────────────────────────────────────────
  {
    brand: 'KSM-66',
    name: 'Ashwagandha Root Extract',
    query: 'ksm 66 ashwagandha',
    mustMatchKeywords: ['ksm', 'ashwagandha'],
  },
  {
    brand: 'Nutricost',
    name: 'Ashwagandha 600mg',
    query: 'nutricost ashwagandha 600',
    mustMatchKeywords: ['nutricost', 'ashwagandha'],
  },
  {
    brand: 'Nutricost',
    name: 'Creatine Monohydrate',
    query: 'nutricost creatine monohydrate',
    mustMatchKeywords: ['nutricost', 'creatine'],
    subcategoryHint: 'pre_workout',
  },

  // ── BulkSupplements ────────────────────────────────────────────────────
  {
    brand: 'BulkSupplements',
    name: 'Creatine Monohydrate Powder',
    query: 'bulksupplements creatine monohydrate',
    mustMatchKeywords: ['bulksupplements', 'creatine'],
    subcategoryHint: 'pre_workout',
  },
];
