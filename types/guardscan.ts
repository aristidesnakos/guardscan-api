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

export type ScoreBreakdown = {
  overall_score: number;
  rating: RatingLabel;
  score_version: string;
  scored_at: string;
  personalized: boolean;
  dimensions: ScoreDimension[];
  flagged_ingredients: FlaggedIngredient[];
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

export type UserProfile = {
  id: string;
  user_id: string;
  age: number | null;
  life_stage: LifeStage;
  trying_to_conceive: boolean;
  allergens: string[];
  dietary_approach: DietaryApproach;
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
  min_score?: number;
};

export type PaginatedResponse<T> = {
  data: T[];
  total: number;
  limit: number;
  offset: number;
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
