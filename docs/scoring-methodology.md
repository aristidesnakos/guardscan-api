# GuardScan Scoring Methodology

## Overview

GuardScan scores products on a **0-100 scale** using ingredient-level safety analysis and, where available, nutritional quality data. The scoring is transparent, deterministic, and personalized to user life stages.

### Rating Bands

| Score | Rating | Color |
|-------|--------|-------|
| 80-100 | Excellent | Green |
| 60-79 | Good | Lime |
| 40-59 | Mediocre | Orange |
| 0-39 | Poor | Red |

---

## Product Categories

GuardScan evaluates three product categories, each with a tailored scoring approach:

| Category | Data Sources | Scoring Dimensions |
|----------|-------------|-------------------|
| **Food** | Open Food Facts | Nutritional Quality (60%) + Ingredient Safety (40%) |
| **Grooming** | Open Beauty Facts | Ingredient Safety (100%) |
| **Supplement** | NIH DSLD | Four-dimension quality scoring (coming soon) |

---

## Food Scoring

Food products are scored across two dimensions when Nutri-Score data is available:

### Dimension 1: Nutritional Quality (60% weight)

Derived from the product's **Nutri-Score** (the European nutritional grading system). GuardScan converts the raw Nutri-Score (range: -15 to 40, lower = better) to a 0-100 scale:

| Nutri-Score (raw) | GuardScan Score | Meaning |
|---|---|---|
| -15 | 100 | Exceptional nutritional profile |
| 0 | 73 | Good nutritional profile |
| 10 | 55 | Moderate profile |
| 20 | 36 | Poor profile |
| 40 | 0 | Very poor profile |

When Nutri-Score data is unavailable, Ingredient Safety carries 100% of the score weight.

### Dimension 2: Ingredient Safety (40% weight)

See the Ingredient Safety section below.

---

## Grooming / Personal Care Scoring

Grooming products are scored purely on **Ingredient Safety** (100% weight). Nutritional metrics like Nutri-Score do not apply to personal care products.

The ingredient dictionary includes cosmetic-specific entries covering endocrine disruptors, allergens, irritants, and environmental concerns relevant to grooming products.

---

## Ingredient Safety Scoring (All Categories)

The core scoring algorithm is shared across food and grooming products:

### Step 1: Start at 100

Every product begins with a perfect score.

### Step 2: Position-Weighted Deductions

Ingredients are evaluated by their **position** in the ingredient list (listed by weight per FDA/EU regulations). Earlier positions mean higher concentration:

| Position | Tier | Negative | Caution | Positive |
|----------|------|----------|---------|----------|
| 1-3 | High | -15 | -8 | +5 |
| 4-8 | Mid | -10 | -5 | +3 |
| 9+ | Low | -5 | -3 | +2 |

**Neutral ingredients receive no deduction or bonus.**

### Step 3: Ingredient Flags

Each ingredient is classified against GuardScan's curated dictionary:

| Flag | Meaning | Example |
|------|---------|---------|
| **Positive** | Beneficial ingredient | Water, Glycerin, Vitamin E |
| **Neutral** | Safe / no significant concern | Most standard ingredients |
| **Caution** | Minor concern at high levels | Fragrance (undisclosed mixture), Stearic Acid |
| **Negative** | Ingredient of concern | BHT, Sodium Nitrite, Parabens |

Unknown ingredients default to **Neutral** -- GuardScan does not penalize ingredients it hasn't evaluated.

### Step 4: Life-Stage Personalization

For users who set a life stage, deductions on fertility-relevant or testosterone-relevant ingredients are amplified:

| Life Stage | Multiplier | Effect |
|-----------|-----------|--------|
| Actively Trying to Conceive | 1.5x | Heavier penalty on endocrine disruptors, fertility-relevant chemicals |
| Testosterone Optimization | 1.3x | Heavier penalty on testosterone-disrupting ingredients |
| Longevity Focus | 1.2x | Moderate increase on harmful ingredient penalties |
| Athletic Performance | 1.0x | Standard scoring |
| General Wellness | 1.0x | Standard scoring |

The multiplier only applies to **negative deductions** on sensitive ingredients. Positive ingredients are not scaled up.

### Step 5: Clamp to 0-100

The final score is clamped to [0, 100].

---

## Supplement Scoring (Coming Soon)

Supplements will be scored across four dimensions:

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Third-Party Testing & Quality | 30% | NSF, USP, ConsumerLab certifications |
| Ingredient Efficacy | 25% | Clinically effective doses, bioavailable forms |
| Contaminant Risk | 25% | Heavy metals, microplastics, pesticide residues |
| Formulation Integrity | 20% | Filler ratio, capsule quality, stability |

A minimum of 2 dimensions must have data for a score to be generated.

---

## How GuardScan Compares to Yuka

| Aspect | GuardScan | Yuka |
|--------|-----------|------|
| **Food Scoring** | 60% nutrition + 40% ingredient safety | 60% nutrition + 30% additives + 10% organic |
| **Cosmetics Scoring** | 100% ingredient safety with position-weighted deductions | Capped by worst ingredient (1 hazardous = max 25/100) |
| **Personalization** | Life-stage multipliers (fertility, testosterone, longevity) | No personalization |
| **Unknown Ingredients** | Neutral (no penalty) | Not scored |
| **Rating Scale** | 0-100, four bands (Excellent/Good/Mediocre/Poor) | 0-100, four bands (Excellent/Good/Poor/Bad) |
| **Supplements** | Dedicated 4-dimension scoring (coming soon) | Not supported |
| **Transparency** | Full ingredient breakdown with per-ingredient deductions shown | Shows risk level per ingredient |

### Key Differentiators

1. **Position-weighted scoring**: GuardScan penalizes harmful ingredients more when they appear earlier (higher concentration), rather than using a flat penalty. Yuka caps cosmetics scores by the single worst ingredient regardless of concentration.

2. **Life-stage personalization**: Users trying to conceive or optimizing testosterone see amplified penalties on relevant endocrine disruptors. No competitor offers this.

3. **Supplement support**: Dedicated four-dimension scoring for dietary supplements goes beyond ingredient-list analysis to assess manufacturing quality, testing, and efficacy.

4. **Conservative unknowns**: Unknown ingredients default to Neutral, avoiding false alarms on novel or regional ingredients that haven't been evaluated yet.

---

## Scoring Version

Current: **v1.1.0**

Score versions are stamped on every score output, enabling the app to detect when a product should be re-scored after algorithm updates.

---

## Data Sources

| Source | Coverage | Data Provided |
|--------|----------|--------------|
| [Open Food Facts](https://world.openfoodfacts.org) | 3M+ food products | Ingredients, Nutri-Score, categories, nutrition facts |
| [Open Beauty Facts](https://world.openbeautyfacts.org) | 62K+ cosmetic products | Ingredients, categories |
| [NIH DSLD](https://dsld.od.nih.gov) | 180K+ supplement labels | Active ingredients, inactive ingredients, brand, forms |

---

## Category Detection

Products are automatically classified using a multi-signal approach:

1. **Data source**: Products from Open Beauty Facts are classified as grooming; products from DSLD are classified as supplements.
2. **Category tags**: Open Food Facts category taxonomy tags (e.g., `en:body-creams`, `en:shampoos`) can override the default food classification.
3. **Product name**: Keywords in the product name (e.g., "moisturizing cream", "shampoo", "body wash") serve as a fallback detection signal.

When a product exists in both food and beauty databases, GuardScan uses the beauty database when grooming signals are detected, ensuring accurate categorization and scoring.
