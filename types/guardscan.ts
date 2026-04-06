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
