/**
 * Domain types shared between GuardScan backend and clients.
 * Must stay structurally compatible with Expo app's types/guardscan.ts.
 */

export type ProductCategory = 'food' | 'grooming' | 'supplement';

export type DataCompleteness = 'full' | 'partial' | 'barcode_only' | 'not_found';

export type IngredientSource =
  | 'verified'
  | 'open_food_facts'
  | 'user_contributed'
  | 'none';

export type IngredientFlag = 'positive' | 'neutral' | 'caution' | 'negative';

export type Ingredient = {
  name: string;
  position: number;
  flag: IngredientFlag;
  reason: string;
  fertility_relevant: boolean;
  testosterone_relevant: boolean;
  /**
   * Hazard tags from the dictionary (e.g. 'endocrine_disruptor', 'reproductive_toxin',
   * 'carcinogen', 'irritant'). Empty array for unknowns. Used by M5.1 outcome rubric
   * to compute hormone_hijack / t_suppressor severity per product.
   */
  health_risk_tags: string[];
  /** true iff the ingredient was found in the dictionary; false = no data. */
  assessed: boolean;
};

export type Product = {
  id: string;
  barcode: string;
  name: string;
  brand: string;
  category: ProductCategory;
  subcategory: string | null;
  image_url: string | null;
  data_completeness: DataCompleteness;
  ingredient_source: IngredientSource;
  ingredients: Ingredient[];
  created_at: string;
  updated_at: string;
};

export type RatingLabel = 'Excellent' | 'Good' | 'Mediocre' | 'Poor';

export type FlaggedIngredient = {
  name: string;
  flag: IngredientFlag;
  reason: string;
  position: number;
  deduction: number;
};

export type ScoreDimension = {
  name: string;
  score: number;
  weight: number;
  description: string;
};

export type AssessmentCoverage = {
  total: number;     // ingredients.length
  assessed: number;  // ingredients with assessed: true
  percentage: number; // 0 when total === 0 (no NaN)
};

// ── M5.1 outcome scoring ────────────────────────────────────────────────────
//
// Outcome rubric runs alongside the numeric score. Two axes ship at first
// launch (hormone_hijack, t_suppressor); recall + counterfeit_risk are
// reserved for M5.3 / M5.4 lifecycle-driven entries (not computed in this
// scoring pass — added by upstream pipelines).
//
// `outcome_flags` is the denormalized per-axis severity. `outcome_lines` is
// the rendered list with reason text + contributing ingredients consumed by
// FE OutcomeLines / shelf chips.

export type OutcomeAxis =
  | 'hormone_hijack'
  | 't_suppressor'
  | 'counterfeit_risk'
  | 'recall';

export type OutcomeSeverity = 'clear' | 'flagged' | 'severe';

export type OutcomeFlags = {
  hormone_hijack: OutcomeSeverity;
  t_suppressor: OutcomeSeverity;
};

export type OutcomeLine = {
  category: OutcomeAxis;
  severity: OutcomeSeverity;
  /** One-sentence — drives FE chip + drawer copy. */
  reason: string;
  /**
   * Positions (1-indexed) of ingredients that contributed to this severity,
   * in ascending order. Position is the per-product primary key for ingredients
   * — set at ingest, never changes — so it survives dictionary renames /
   * normalization shifts that would break a name-based join. FE drawer
   * resolves these by `ingredients.find(i => i.position === pos)`.
   */
  contributing_ingredient_positions?: number[];
  /** Mandatory at `severe`; omitted at `flagged`/`clear`. */
  study_link?: string;
};

export type ScoreBreakdown = {
  overall_score: number;
  rating: RatingLabel;
  score_version: string;
  scored_at: string;
  personalized: boolean;
  dimensions: ScoreDimension[];
  flagged_ingredients: FlaggedIngredient[];
  assessment_coverage: AssessmentCoverage;
  /** M5.1 — denorm of axis severities. */
  outcome_flags: OutcomeFlags;
  /** M5.1 — full rendered outcome lines (ordered: severe → flagged → clear). */
  outcome_lines: OutcomeLine[];
};

export type ScanResult = {
  product: Product;
  score: ScoreBreakdown | null;
  /** Null in M1 (food + grooming via OFF). Populated in M2 with DSLD. */
  supplement_quality: null;
  /** Empty array in M1. Populated in M2.5 (Recommendations backing API). */
  alternatives: ProductAlternative[];
};

export type ProductAlternative = {
  product: Product;
  score: number;
  rating: RatingLabel;
  reason: string;
};

/** A scanned Poor/Mediocre product paired with its best alternative, used on the Recs tab. */
export type RecommendationPair = {
  scanned: {
    product: Product;
    score: number;
    rating: RatingLabel;
    scanned_at: string;
  };
  alternative: ProductAlternative;
  subcategory_hint?: string;
};

/** Filters applied on the Recs tab. */
export type RecommendationsFilter = {
  category?: ProductCategory;
};

// TODO(multi-brand): LifeStage enum is Mangood-biased — only men's-health
// values. When Pomenatal onboards, extend with pregnancy/postpartum variants
// or split into a brand-scoped type. See docs/multi-brand-migration.md.
export type LifeStage =
  | 'general_wellness'
  | 'actively_trying_to_conceive'
  | 'testosterone_optimization'
  | 'athletic_performance'
  | 'longevity_focus';

export type DietaryApproach =
  | 'standard'
  | 'keto'
  | 'carnivore'
  | 'mediterranean'
  | 'paleo'
  | 'vegetarian'
  | 'vegan';

export type SubscriptionTier = 'free' | 'pro';

export type UserProfile = {
  id: string;
  user_id: string;
  age: number | null;
  life_stage: LifeStage;
  trying_to_conceive: boolean;
  allergens: string[];
  dietary_approach: DietaryApproach;
  subscription_tier: SubscriptionTier;
};

export type SubscriptionStatus = {
  tier: SubscriptionTier;
  /** ISO-8601 timestamp of when the current period ends, or null for free tier. */
  expires_at: string | null;
};

export type ScanHistoryItem = {
  id: string;
  product: Product;
  score: number | null;
  rating: RatingLabel | null;
  scanned_at: string;
  is_favorite: boolean;
};

export type SearchFilters = {
  query: string;
  category?: ProductCategory;
  subcategory?: string;
  min_score?: number;
  sort_by?: 'relevance' | 'best_rated';
};

/**
 * Autocomplete suggestion returned by GET /api/products/search/suggestions.
 * Mirrors the Expo client's SearchSuggestion so the client can render
 * HighlightedText using the matchStart/matchEnd offsets.
 */
export type SearchSuggestion = {
  text: string;
  matchStart: number;
  matchEnd: number;
};

export type SearchResultItem = {
  product: Product;
  score: number | null;
  rating: RatingLabel | null;
};

/**
 * Ingredient detail returned by GET /api/ingredients/:normalized.
 * Returns only enrichment fields — the Expo app already has flag/reason/
 * fertility_relevant/testosterone_relevant from the scan result's Ingredient
 * type, so we avoid duplicating those here.
 *
 * If description is null (pre-Phase 3), the app falls back to showing
 * the reason sentence from the scan result.
 */
export type IngredientDetail = {
  normalized: string;
  display_name: string;
  ingredient_group: string;
  health_risk_tags: string[];
  description: string | null;  // null until Phase 3 description generation
  evidence_url: string;
};

export type PaginatedResponse<T> = {
  data: T[];
  total: number;
  limit: number;
  offset: number;
};

// ── Shelf (M4) ──────────────────────────────────────────────────────────────
//
// Manual, user-curated product collection. See
// cucumberdude/docs/product/FEATURES/SHELF.md and
// guardscan-api/docs/milestones/m4-shelf.md for full semantics.
//
// Denormalized snapshot fields (product_name/brand/category, current_score)
// are refreshed on rescore — see backend milestone doc.

export type ShelfItem = {
  id: string;
  product_id: string;
  product_name: string;
  product_brand: string;
  product_category: ProductCategory;
  current_score: number | null;
  product_image_url: string | null;
  added_date: string;
  scan_date: string;
  swapped_from_id: string | null;
  /** Resolved name of the swapped-from product for the meta line. Null if no swap or product missing. */
  swapped_from_name: string | null;
};

export type ShelfStats = {
  total_count: number;
  /** Numeric mean of items with non-null score. Null when scored_item_count < 3. */
  average_score: number | null;
  /** Count of shelf items where item.score IS NOT NULL AND ∃ alt in same subcategory with strictly higher non-null score. */
  upgrades_available: number;
  /** Product IDs of shelf items that contributed to upgrades_available — used by FE to filter the list when the user taps the upgrade row. */
  upgrade_product_ids: string[];
  /** Count of shelf items with non-null score. FE hides average_score + upgrades_available rows when < 3. */
  scored_item_count: number;
};

export type ShelfResponse = {
  items: ShelfItem[];
  stats: ShelfStats;
};

export type SwapCandidate = {
  shelf_item_id: string;
  product_id: string;
  product_name: string;
  product_brand: string;
  current_score: number | null;
};

export type AddToShelfRequest = {
  product_ids: string[];
};

export type AddToShelfResponse = {
  /** Product IDs successfully added (excludes duplicates and unknown products). */
  added: string[];
  /** Product IDs already on the user's shelf. */
  duplicates: string[];
  /** Product IDs that failed (e.g. unknown product, db error). */
  errors: string[];
  /**
   * Lower-scored shelf items in the same subcategory as the added product.
   * Only populated when product_ids.length === 1 (single-add path).
   * Map keyed by added product_id. Empty/omitted when no candidates exist.
   */
  swap_candidates?: Record<string, SwapCandidate[]>;
};

export type UpdateShelfRequest = {
  // Reserved for future fields. scan_date is intentionally NOT updatable here.
  product_category?: ProductCategory;
};

export type DeleteShelfRequest = {
  /**
   * If present, atomically:
   *   1) sets swapped_from_id on the shelf row matching this product_id
   *      to the product_id of the row being deleted
   *   2) deletes this row
   */
  swap_link_to_product_id?: string;
};

export type DeleteShelfResponse = {
  deleted: boolean;
  linked: boolean;
};

// ── User submissions (M3.0 / M3.1) ──────────────────────────────────────────
//
// Response shape from POST /api/products/submit. Three terminal outcomes:
//   - pending_review: submission stored, OCR may still be running or
//     Claude's confidence was below AUTO_PUBLISH_CONFIDENCE_THRESHOLD
//   - already_in_catalog: barcode already existed, no submission created
//   - auto_published: M3.1 — Claude extraction met confidence + guardrails
//     and the product was written straight into `products`

export type SubmissionResponse =
  | { status: 'pending_review'; submission_id: string; message?: string }
  | { status: 'already_in_catalog'; product_id: string; message?: string }
  | {
      status: 'auto_published';
      submission_id: string;
      product_id: string;
      message?: string;
    };
