/**
 * Layer 1 — Top US men's grooming targets.
 *
 * These are the SKUs users are most likely to scan on day one. Each entry
 * is a *targeting* descriptor, not a fabricated product row — the seed
 * script resolves each entry to a real OBF barcode via targeted search,
 * then upserts the authoritative OBF data.
 *
 * If a target can't be resolved via OBF, it's logged as a catalog gap and
 * the user-submission pipeline (M3) will fill it. See CATALOG-GAP-STRATEGY.md
 * §3.3 for the full sequencing rationale.
 *
 * Editing rules:
 *   - `query` must match what OBF indexes (lowercase, spaces, no brand noise
 *     beyond what the brand themselves use).
 *   - `mustMatchKeywords` filters OBF search results down to the specific
 *     variant we want — without this, "Old Spice Classic" can match a dozen
 *     unrelated SKUs.
 *   - `subcategoryHint` overrides the inference in lib/subcategory.ts when
 *     the product name alone is ambiguous (e.g. "Classic" scent).
 *
 * Never fabricate barcodes. If you know a real UPC, use the optional `upc`
 * field — the seed script will fetch it directly.
 */

export type GroomingTarget = {
  brand: string;
  name: string;
  /** OBF search query — typically "brand name" lowercased. */
  query: string;
  /** All of these tokens must appear in the matched product name. */
  mustMatchKeywords: string[];
  /** Forces a subcategory when inference from the product name is ambiguous. */
  subcategoryHint?: string;
  /** Known UPC — fetched directly, skipping search. */
  upc?: string;
};

export const TOP_GROOMING_TARGETS: GroomingTarget[] = [
  // ── Old Spice ──────────────────────────────────────────────────────────
  {
    brand: 'Old Spice',
    name: 'Classic After Hours Stick Deodorant',
    query: 'old spice classic after hours deodorant',
    mustMatchKeywords: ['old spice', 'after hours'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Old Spice',
    name: 'Pure Sport Antiperspirant & Deodorant',
    query: 'old spice pure sport deodorant',
    mustMatchKeywords: ['old spice', 'pure sport'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Old Spice',
    name: 'Swagger Antiperspirant & Deodorant',
    query: 'old spice swagger deodorant',
    mustMatchKeywords: ['old spice', 'swagger'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Old Spice',
    name: 'Bearglove Body Wash',
    query: 'old spice bearglove body wash',
    mustMatchKeywords: ['old spice', 'bearglove'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Old Spice',
    name: 'High Endurance Body Wash',
    query: 'old spice high endurance body wash',
    mustMatchKeywords: ['old spice', 'high endurance'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Old Spice',
    name: 'Fiji Body Wash',
    query: 'old spice fiji body wash',
    mustMatchKeywords: ['old spice', 'fiji'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Old Spice',
    name: 'Red Zone Body Spray',
    query: 'old spice red zone body spray',
    mustMatchKeywords: ['old spice', 'red zone'],
    subcategoryHint: 'cologne',
  },

  // ── Dove Men+Care ──────────────────────────────────────────────────────
  {
    brand: 'Dove Men+Care',
    name: 'Deep Clean Body Wash',
    query: 'dove men care deep clean body wash',
    mustMatchKeywords: ['dove', 'men', 'deep clean'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Dove Men+Care',
    name: 'Clean Comfort Body Wash',
    query: 'dove men care clean comfort body wash',
    mustMatchKeywords: ['dove', 'men', 'clean comfort'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Dove Men+Care',
    name: 'Extra Fresh Body Wash',
    query: 'dove men care extra fresh body wash',
    mustMatchKeywords: ['dove', 'men', 'extra fresh'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Dove Men+Care',
    name: 'Clean Comfort Antiperspirant',
    query: 'dove men care clean comfort antiperspirant',
    mustMatchKeywords: ['dove', 'men', 'clean comfort'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Dove Men+Care',
    name: 'Extra Fresh Antiperspirant',
    query: 'dove men care extra fresh antiperspirant',
    mustMatchKeywords: ['dove', 'men', 'extra fresh'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Dove Men+Care',
    name: 'Fortifying 2-in-1 Shampoo + Conditioner',
    query: 'dove men care fortifying shampoo conditioner',
    mustMatchKeywords: ['dove', 'men', 'fortifying'],
    subcategoryHint: 'shampoo',
  },

  // ── Nivea Men ──────────────────────────────────────────────────────────
  {
    brand: 'Nivea Men',
    name: 'Sensitive Post Shave Balm',
    query: 'nivea men sensitive post shave balm',
    mustMatchKeywords: ['nivea', 'men', 'sensitive'],
    subcategoryHint: 'shave',
  },
  {
    brand: 'Nivea Men',
    name: 'Sensitive Shaving Gel',
    query: 'nivea men sensitive shaving gel',
    mustMatchKeywords: ['nivea', 'men', 'shaving'],
    subcategoryHint: 'shave',
  },
  {
    brand: 'Nivea Men',
    name: 'Original Moisturizing Body Wash',
    query: 'nivea men original body wash',
    mustMatchKeywords: ['nivea', 'men', 'body wash'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Nivea Men',
    name: 'Creme',
    query: 'nivea men creme',
    mustMatchKeywords: ['nivea', 'men', 'creme'],
    subcategoryHint: 'moisturizer',
  },

  // ── Dr. Squatch ────────────────────────────────────────────────────────
  {
    brand: 'Dr. Squatch',
    name: 'Pine Tar Bar Soap',
    query: 'dr squatch pine tar soap',
    mustMatchKeywords: ['squatch', 'pine tar'],
    subcategoryHint: 'soap',
  },
  {
    brand: 'Dr. Squatch',
    name: 'Cool Fresh Aloe Bar Soap',
    query: 'dr squatch cool fresh aloe soap',
    mustMatchKeywords: ['squatch', 'cool fresh aloe'],
    subcategoryHint: 'soap',
  },
  {
    brand: 'Dr. Squatch',
    name: 'Birchwood Breeze Bar Soap',
    query: 'dr squatch birchwood breeze soap',
    mustMatchKeywords: ['squatch', 'birchwood'],
    subcategoryHint: 'soap',
  },
  {
    brand: 'Dr. Squatch',
    name: 'Bay Rum Bar Soap',
    query: 'dr squatch bay rum soap',
    mustMatchKeywords: ['squatch', 'bay rum'],
    subcategoryHint: 'soap',
  },

  // ── Every Man Jack ─────────────────────────────────────────────────────
  {
    brand: 'Every Man Jack',
    name: 'Cedarwood Body Wash',
    query: 'every man jack cedarwood body wash',
    mustMatchKeywords: ['every man jack', 'cedarwood'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Every Man Jack',
    name: 'Sea Salt Deodorant',
    query: 'every man jack sea salt deodorant',
    mustMatchKeywords: ['every man jack', 'sea salt'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Every Man Jack',
    name: 'Activated Charcoal Face Wash',
    query: 'every man jack activated charcoal face wash',
    mustMatchKeywords: ['every man jack', 'charcoal'],
    subcategoryHint: 'cleanser',
  },

  // ── Harry's ────────────────────────────────────────────────────────────
  {
    brand: "Harry's",
    name: 'Shave Gel',
    query: 'harrys shave gel',
    mustMatchKeywords: ['harry', 'shave'],
    subcategoryHint: 'shave',
  },
  {
    brand: "Harry's",
    name: 'Face Wash',
    query: 'harrys face wash',
    mustMatchKeywords: ['harry', 'face wash'],
    subcategoryHint: 'cleanser',
  },
  {
    brand: "Harry's",
    name: 'Body Wash',
    query: 'harrys body wash',
    mustMatchKeywords: ['harry', 'body wash'],
    subcategoryHint: 'body_wash',
  },

  // ── Duke Cannon ────────────────────────────────────────────────────────
  {
    brand: 'Duke Cannon',
    name: 'Big Ass Brick of Soap',
    query: 'duke cannon big ass brick soap',
    mustMatchKeywords: ['duke cannon', 'brick'],
    subcategoryHint: 'soap',
  },
  {
    brand: 'Duke Cannon',
    name: 'Bloody Knuckles Hand Repair',
    query: 'duke cannon bloody knuckles hand repair',
    mustMatchKeywords: ['duke cannon', 'bloody knuckles'],
    subcategoryHint: 'moisturizer',
  },
  {
    brand: 'Duke Cannon',
    name: 'Superior Grade Grooming Aid',
    query: 'duke cannon superior grade grooming',
    mustMatchKeywords: ['duke cannon', 'grooming'],
    subcategoryHint: 'hair_styling',
  },

  // ── Bulldog ────────────────────────────────────────────────────────────
  {
    brand: 'Bulldog',
    name: 'Original Face Wash',
    query: 'bulldog original face wash',
    mustMatchKeywords: ['bulldog', 'face wash'],
    subcategoryHint: 'cleanser',
  },
  {
    brand: 'Bulldog',
    name: 'Original Moisturizer',
    query: 'bulldog original moisturizer',
    mustMatchKeywords: ['bulldog', 'moisturizer'],
    subcategoryHint: 'moisturizer',
  },
  {
    brand: 'Bulldog',
    name: 'Original Beard Oil',
    query: 'bulldog original beard oil',
    mustMatchKeywords: ['bulldog', 'beard oil'],
    subcategoryHint: 'beard',
  },

  // ── Jack Black ─────────────────────────────────────────────────────────
  {
    brand: 'Jack Black',
    name: 'Pure Clean Daily Facial Cleanser',
    query: 'jack black pure clean facial cleanser',
    mustMatchKeywords: ['jack black', 'pure clean'],
    subcategoryHint: 'cleanser',
  },
  {
    brand: 'Jack Black',
    name: 'Double-Duty Face Moisturizer SPF 20',
    query: 'jack black double duty face moisturizer',
    mustMatchKeywords: ['jack black', 'double-duty'],
    subcategoryHint: 'moisturizer',
  },
  {
    brand: 'Jack Black',
    name: 'Beard Lube Conditioning Shave',
    query: 'jack black beard lube shave',
    mustMatchKeywords: ['jack black', 'beard lube'],
    subcategoryHint: 'shave',
  },

  // ── Cremo ──────────────────────────────────────────────────────────────
  {
    brand: 'Cremo',
    name: 'Original Shave Cream',
    query: 'cremo original shave cream',
    mustMatchKeywords: ['cremo', 'shave cream'],
    subcategoryHint: 'shave',
  },
  {
    brand: 'Cremo',
    name: 'Bourbon & Oak Body Wash',
    query: 'cremo bourbon oak body wash',
    mustMatchKeywords: ['cremo', 'bourbon'],
    subcategoryHint: 'body_wash',
  },

  // ── Baxter of California ───────────────────────────────────────────────
  {
    brand: 'Baxter of California',
    name: 'Daily Face Wash',
    query: 'baxter california daily face wash',
    mustMatchKeywords: ['baxter', 'face wash'],
    subcategoryHint: 'cleanser',
  },
  {
    brand: 'Baxter of California',
    name: 'Super Shape Skin Recharge Cream',
    query: 'baxter california super shape skin recharge',
    mustMatchKeywords: ['baxter', 'super shape'],
    subcategoryHint: 'moisturizer',
  },

  // ── Brickell ───────────────────────────────────────────────────────────
  {
    brand: 'Brickell',
    name: 'Purifying Charcoal Face Wash for Men',
    query: 'brickell charcoal face wash men',
    mustMatchKeywords: ['brickell', 'charcoal'],
    subcategoryHint: 'cleanser',
  },
  {
    brand: 'Brickell',
    name: 'Daily Essential Face Moisturizer for Men',
    query: 'brickell daily essential face moisturizer men',
    mustMatchKeywords: ['brickell', 'face moisturizer'],
    subcategoryHint: 'moisturizer',
  },

  // ── Axe ────────────────────────────────────────────────────────────────
  {
    brand: 'Axe',
    name: 'Apollo Body Wash',
    query: 'axe apollo body wash',
    mustMatchKeywords: ['axe', 'apollo'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Axe',
    name: 'Phoenix Body Wash',
    query: 'axe phoenix body wash',
    mustMatchKeywords: ['axe', 'phoenix'],
    subcategoryHint: 'body_wash',
  },
  {
    brand: 'Axe',
    name: 'Dark Temptation Antiperspirant',
    query: 'axe dark temptation antiperspirant',
    mustMatchKeywords: ['axe', 'dark temptation'],
    subcategoryHint: 'deodorant',
  },

  // ── Gillette ───────────────────────────────────────────────────────────
  {
    brand: 'Gillette',
    name: 'Fusion Hydra Gel Shave',
    query: 'gillette fusion hydra gel shave',
    mustMatchKeywords: ['gillette', 'fusion'],
    subcategoryHint: 'shave',
  },
  {
    brand: 'Gillette',
    name: 'Sensitive Skin Shave Gel',
    query: 'gillette sensitive shave gel',
    mustMatchKeywords: ['gillette', 'sensitive'],
    subcategoryHint: 'shave',
  },
  {
    brand: 'Gillette',
    name: 'Cool Wave Clear Gel Antiperspirant',
    query: 'gillette cool wave gel antiperspirant',
    mustMatchKeywords: ['gillette', 'cool wave'],
    subcategoryHint: 'deodorant',
  },

  // ── Kiehl's ────────────────────────────────────────────────────────────
  {
    brand: "Kiehl's",
    name: 'Facial Fuel Energizing Face Wash',
    query: 'kiehls facial fuel face wash',
    mustMatchKeywords: ['kiehl', 'facial fuel'],
    subcategoryHint: 'cleanser',
  },
  {
    brand: "Kiehl's",
    name: 'Facial Fuel Energizing Moisture Treatment',
    query: 'kiehls facial fuel moisture',
    mustMatchKeywords: ['kiehl', 'facial fuel'],
    subcategoryHint: 'moisturizer',
  },

  // ── Lab Series ─────────────────────────────────────────────────────────
  {
    brand: 'Lab Series',
    name: 'Oil Control Daily Face Wash',
    query: 'lab series oil control face wash',
    mustMatchKeywords: ['lab series', 'face wash'],
    subcategoryHint: 'cleanser',
  },

  // ── American Crew ──────────────────────────────────────────────────────
  {
    brand: 'American Crew',
    name: 'Daily Cleansing Shampoo',
    query: 'american crew daily cleansing shampoo',
    mustMatchKeywords: ['american crew', 'shampoo'],
    subcategoryHint: 'shampoo',
  },
  {
    brand: 'American Crew',
    name: 'Fiber Pomade',
    query: 'american crew fiber pomade',
    mustMatchKeywords: ['american crew', 'fiber'],
    subcategoryHint: 'hair_styling',
  },

  // ── Suave Men ──────────────────────────────────────────────────────────
  {
    brand: 'Suave Men',
    name: '2-in-1 Shampoo + Conditioner',
    query: 'suave men 2 in 1 shampoo conditioner',
    mustMatchKeywords: ['suave', 'men'],
    subcategoryHint: 'shampoo',
  },

  // ── Speed Stick ────────────────────────────────────────────────────────
  {
    brand: 'Speed Stick',
    name: 'Regular Deodorant',
    query: 'speed stick regular deodorant',
    mustMatchKeywords: ['speed stick', 'regular'],
    subcategoryHint: 'deodorant',
  },
  {
    brand: 'Speed Stick',
    name: 'Gear Clinical Strength Antiperspirant',
    query: 'speed stick gear clinical antiperspirant',
    mustMatchKeywords: ['speed stick', 'gear'],
    subcategoryHint: 'deodorant',
  },

  // ── Crest / Colgate (oral care — men's bathroom staples) ───────────────
  {
    brand: 'Crest',
    name: 'Pro-Health Advanced Toothpaste',
    query: 'crest pro health advanced toothpaste',
    mustMatchKeywords: ['crest', 'pro-health'],
    subcategoryHint: 'toothpaste',
  },
  {
    brand: 'Colgate',
    name: 'Total Whitening Toothpaste',
    query: 'colgate total whitening toothpaste',
    mustMatchKeywords: ['colgate', 'total'],
    subcategoryHint: 'toothpaste',
  },

  // ── Sunscreen ─────────────────────────────────────────────────────────
  {
    brand: 'Neutrogena',
    name: 'Ultra Sheer Dry-Touch Sunscreen SPF 55',
    query: 'neutrogena ultra sheer sunscreen spf 55',
    mustMatchKeywords: ['neutrogena', 'ultra sheer'],
    subcategoryHint: 'sunscreen',
  },
  {
    brand: 'Banana Boat',
    name: 'Ultra Sport Sunscreen Lotion SPF 50',
    query: 'banana boat ultra sport sunscreen spf 50',
    mustMatchKeywords: ['banana boat', 'ultra sport'],
    subcategoryHint: 'sunscreen',
  },
  {
    brand: 'Coppertone',
    name: 'Sport Sunscreen Lotion SPF 50',
    query: 'coppertone sport sunscreen spf 50',
    mustMatchKeywords: ['coppertone', 'sport'],
    subcategoryHint: 'sunscreen',
  },
];
