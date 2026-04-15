# Scoring Calibration Protocol — Grooming v1.x

**Status:** Active
**Applies to:** ManGood grooming category scoring (v1.2.0+)
**Related:** [scoring.md](./scoring.md), [scoring-v1.2-subtract-only-report.md](./scoring-v1.2-subtract-only-report.md)
**Tools:** `/admin/calibration` page, `scripts/rescore-products.ts`

---

## 1. Purpose

This protocol governs how ManGood recalibrates its grooming ingredient scoring against external reference benchmarks (primarily Yuka). The goal is not perfect numerical alignment with any single competitor — it is to ensure that ManGood scores reflect genuine safety risk so that:

1. A product with a documented hazardous ingredient cannot score in the "Excellent" or "Good" band.
2. Products that knowledgeable consumers, dermatologists, or toxicologists would consider problematic score at "Mediocre" or lower.
3. Score differences from competitors are attributable to deliberate design choices (life-stage personalisation, subtract-only model) rather than miscalibration.

Calibration is triggered when:
- A new batch of products is added to the catalog.
- The ingredient dictionary is significantly updated.
- A user or operator flags a product whose score does not match intuition.
- A SCORE_VERSION bump is planned.

---

## 2. Scientific Foundation

Before running numbers, operators must understand the scientific basis for ingredient risk. The following principles govern every calibration decision.

### 2.1 INCI List Order as Concentration Proxy

EU Cosmetics Regulation 1223/2009 and FDA 21 CFR 701.3 both require ingredients to be listed in descending order of weight/concentration — **down to 1%.** Below 1%, manufacturers may list ingredients in any order. This means:

- Positions 1–5: typically major components, often 5–80% concentration.
- Positions 6–12: minor components, typically 0.5–5%.
- Positions 13+: micro-ingredients, frequently at or below 1% — and their order relative to each other is legally meaningless.

**Practical consequence for scoring:** The algorithm's position tiers (high: 1–3, mid: 4–8, low: 9+) are a reasonable approximation for the high-concentration range but become unreliable below position 9. Two ingredients at positions 14 and 16 may be at identical concentrations. Position-based deductions at the "low" tier (-3 for caution, -5 for negative) already reflect this reduced signal; do not further reduce them.

### 2.2 Rinse-Off vs Leave-On Exposure

The European Scientific Committee on Consumer Safety (SCCS) and the Cosmetic Ingredient Review (CIR) explicitly set different safe concentration thresholds for rinse-off versus leave-on products. The exposure difference is significant:

| Exposure type | Examples | Contact time | Dermal absorption |
|---|---|---|---|
| Leave-on | Moisturiser, deodorant, aftershave, serum | Hours–continuous | Full or near-full |
| Rinse-off | Shaving cream, shampoo, body wash, face wash | Seconds–minutes | 10–30× lower |
| Incidental mucous | Eye cream, lip product | Hours | Elevated vs skin |

**Practical consequence:** The current algorithm has no product-type field and therefore cannot distinguish a shaving cream (rinse-off) from an aftershave balm (leave-on). For SLS, for example, CIR considers it safe at up to 50% in rinse-off products but restricts leave-on use. When calibrating, if an ingredient scores poorly in ManGood but Yuka is lenient, verify whether the product is rinse-off — the discrepancy may be scientifically justified.

A future improvement (out of scope for v1.x calibration) would be to store `application_type: 'rinse_off' | 'leave_on' | 'inhalation'` on the product and apply a risk multiplier accordingly.

### 2.3 Sensitisation vs Irritation

The algorithm currently uses a single flag tier (`caution`, `negative`) without distinguishing between two mechanistically different hazard types:

- **Irritants** (e.g., SLS, high-concentration alcohol): dose-dependent, reversible, affects most people at sufficient concentration. Risk is proportional to concentration → position-weighting is appropriate.
- **Sensitisers/Allergens** (e.g., fragrance components, methylisothiazolinone): trigger an acquired immune response. Once sensitised, a person reacts to even trace amounts. Position-weighting underestimates risk because a sensitiser at position 15 is still dangerous to a sensitised individual.

When calibrating allergen-containing ingredients (Parfum, specific fragrance chemicals, preservatives like MI/MCI), understand that a large gap vs Yuka may reflect their treatment of sensitisers differently rather than a magnitude calibration problem.

### 2.4 Nitrosamine Formation (Triethanolamine and similar)

TEA (triethanolamine) and similar amines form carcinogenic N-nitrosamines specifically when co-formulated with nitrosating agents — typically DEA (diethanolamine) derivatives or formaldehyde-releasing preservatives. TEA alone is not inherently carcinogenic; it is a reactive precursor.

The EU restricts TEA at ≤2.5% (leave-on) and ≤5% (rinse-off), and prohibits it in products containing nitrosating agents. The current dictionary entry flags TEA as `caution` universally, which is a reasonable conservative position given that we cannot inspect co-formulation context.

**Do not downgrade TEA to neutral.** The flag is justified. Calibration note: if ManGood scores a TEA-containing product consistently higher than Yuka, the gap is more likely explained by Yuka's hard cap mechanism than by TEA's classification.

### 2.5 1,4-Dioxane Contamination

1,4-dioxane is a probable human carcinogen (EPA Group B2, IARC Group 2B) that appears as a trace manufacturing contaminant in **ethoxylated ingredients** — any INCI name containing the strings `peg-`, `eth-`, `-eth`, or the suffix `-20`, `-23`, `-40` (denoting the ethoxylation count). It is not listed on labels because it is a contaminant, not an ingredient.

Affected common ingredients: SLES (sodium laureth sulfate), PEG-40 hydrogenated castor oil, laureth-23, ceteareth-20. The current dictionary entry for SLES notes this risk. Laureth-23 (appearing in the sample product) is **not currently in the dictionary** and defaults to neutral — despite being an ethoxylated ingredient with the same contamination pathway.

**Calibration action:** Audit all ethoxylated ingredients in your product catalog that are currently defaulting to neutral and add them to the dictionary as `caution` with the 1,4-dioxane contamination rationale.

### 2.6 Fragrance as a Complex Mixture

"Parfum" or "Fragrance" is legally a single INCI entry that can represent up to several hundred distinct chemicals. The EU Cosmetics Regulation 2023/1545 (effective March 2025 for new products) expanded the list of individually declarable fragrance allergens from 26 to 80+. Products reformulated after this date increasingly list individual allergens (Linalool, Limonene, Geraniol, Cinnamal, Eugenol, etc.) separately.

**Practical consequence:** When scoring products made after 2025, individual fragrance allergens listed explicitly on the label should each be added to the dictionary and scored independently. "Parfum" as a residual entry then covers only undisclosed components. For pre-2025 products (most of the current catalog), "Parfum" as a single `caution` entry understates risk — this supports upgrading it to `negative` for leave-on grooming products.

### 2.7 Cumulative Daily Exposure (Current Limitation)

No consumer scoring app — including Yuka, INCI Beauty, or ManGood — accounts for cumulative daily exposure. A person using 10–15 grooming products per day receives aggregate ingredient doses that are not captured by per-product scoring. This is a known and accepted limitation of the category, not a calibration target.

**However:** it is a strong argument against ever calling any multi-irritant product "Excellent." A product with 4 caution-flagged ingredients in positions 1–8 should not share a band with a product that has zero flagged ingredients, even if the mathematical deductions place them in the same band. This supports the worst-ingredient cap mechanism described in Section 5.3.

---

## 3. Benchmark Reference: Yuka Methodology

Understanding Yuka's approach is essential for interpreting gaps correctly.

| Dimension | Yuka (cosmetics) | ManGood (grooming) |
|---|---|---|
| Score range | 0–100 | 0–100 |
| Starting point | 100, subtract-only | 100, subtract-only |
| Ingredient database | ~4,000+ entries (CosIng + SCCS + EWG) | ~300 entries (curated seed) |
| Position weighting | Yes (high-concentration = higher risk) | Yes (tiers: high/mid/low) |
| Worst-ingredient cap | Yes — 1 hazardous ingredient = max 25 | No cap currently |
| Unknown ingredients | Scored as "unrated" (neutral equivalent) | Neutral (same) |
| Personalisation | No | Yes (life-stage multipliers) |
| Rinse-off adjustment | Not publicly confirmed | Not implemented |

**Key insight from the database size gap:** Yuka has ~13× more entries. For a product with 20 ingredients, ManGood may have 8 in its dictionary; Yuka may have 16. Ingredients that ManGood scores as neutral (unknown) may be scored as caution or negative in Yuka's database. A persistent positive gap (ManGood > Yuka) may simply reflect missing dictionary entries, not wrong deduction magnitudes.

---

## 4. Calibration Workflow

### Phase 1 — Data Collection

**Duration:** Concurrent with product review sessions.
**Tool:** `http://localhost:3000/admin/calibration`

1. For each product in the calibration list, open Yuka on a mobile device and scan the barcode.
2. If Yuka does not recognise the barcode, note it as `yuka_not_found` in the export.
3. Enter the Yuka score (0–100) in the Yuka column. Scores are saved automatically in browser localStorage.
4. Note the Yuka rating band alongside the score (Yuka displays "Excellent", "Good", "Poor", "Bad" — mapping to approximately ≥75, 50–74, 25–49, 0–24).
5. When all products are scored, click **Export CSV**.

**Minimum viable dataset:** 20 grooming products with Yuka scores, distributed across subcategories (shaving cream, aftershave, shampoo, body wash, soap, deodorant/antiperspirant).

---

### Phase 2 — Gap Analysis

Import the exported CSV. For each product compute:

```
gap = mangood_score - yuka_score
```

Then compute the following summary statistics:

| Metric | Formula | Interpretation |
|---|---|---|
| Mean gap | `AVG(gap)` | Overall bias direction |
| Median gap | `MEDIAN(gap)` | Robust to outliers |
| % with gap > 10 | `COUNT(gap > 10) / n` | Scope of over-inflation |
| % with gap > 20 | `COUNT(gap > 20) / n` | Severe over-inflation rate |
| Band mismatch rate | Products where ManGood band ≠ Yuka band | User-visible harm |

**Thresholds for action:**

| Condition | Action required |
|---|---|
| Mean gap > 10 | Structural change needed (cap or flag reclassification) |
| Mean gap 5–10 | Targeted reclassification of 1–2 high-frequency ingredients |
| Mean gap < 5 | Magnitude tuning only; low urgency |
| Band mismatch > 30% | Prioritise cap mechanism — band accuracy matters most to users |

---

### Phase 3 — Root Cause Triage

For every product where `gap > 10`, determine which lever is responsible. Work through these checks in order:

**Check A — Is the gap explained by the worst-ingredient cap?**

Simulate adding a cap: for each product, compute `min(mangood_score, cap)` where `cap = 49` if any ingredient is `negative`, `cap = 74` if any ingredient is `caution` but none `negative`.

If applying the cap reduces the mean gap by ≥5 points, the cap is the primary lever.

**Check B — Are high-frequency flagged ingredients classified too leniently?**

Tabulate which `caution`-flagged ingredients appear most often in high-gap products. If the same ingredient appears in >50% of high-gap products, its flag tier is the primary driver.

Specific candidates to evaluate (based on the v1.2 report and the science above):

| Ingredient | Current flag | Reclassify to? | Trigger condition |
|---|---|---|---|
| Parfum / Fragrance | `caution` | `negative` (grooming) | Present in >50% high-gap products |
| Sodium lauryl sulfate | `caution` | `negative` (leave-on only) | Product is leave-on + gap > 15 |
| Methylisothiazolinone (MI) | `negative` ✓ | n/a | Already correct |
| SLES / Sodium laureth sulfate | `caution` | `caution` ✓ | Already reasonable for rinse-off |
| Triethanolamine | `caution` | `caution` ✓ | Already correct |

**Check C — Are there missing dictionary entries?**

For each high-gap product, identify ingredients currently defaulting to neutral. Cross-reference against EWG Skin Deep or CosIng. If Yuka flags an ingredient that ManGood defaults to neutral, that is a dictionary gap, not a magnitude problem.

Priority missing entries to audit:
- All ethoxylated ingredients (laureth-N, ceteareth-N, PEG-N compounds)
- Isopropyl alcohol / alcohol denat
- Benzyl alcohol
- Cocamidopropyl betaine
- Propylene glycol
- Individually declared EU fragrance allergens (Linalool, Limonene, Geraniol, Citronellol, Eugenol, Cinnamal, Benzyl Alcohol, Cinnamyl Alcohol, Isoeugenol)
- BHT in grooming context (already `negative` for food/both — verify grooming entry)

**Check D — Are deduction magnitudes globally too low?**

If gap is distributed fairly evenly across all products regardless of ingredient mix, and Checks A–C do not explain it, then the deduction ladder itself needs adjustment.

Current ladder for reference:

| Flag | High (pos 1–3) | Mid (pos 4–8) | Low (pos 9+) |
|---|---|---|---|
| Negative | -15 | -10 | -5 |
| Caution | -8 | -5 | -3 |

A globally modest positive gap (mean 5–8) without concentration in specific ingredients suggests increasing caution mid to -7 and caution low to -4. Only make this change if it is supported by the data — do not adjust magnitudes speculatively.

---

### Phase 4 — Implement Changes

Changes are made in this order. Each step is independently reversible via a SCORE_VERSION bump and rescore.

**Step 4a — Dictionary additions (`lib/dictionary/seed.ts`)**

For each missing entry identified in Check C, add a seed entry with:
- `normalized`: lowercase INCI name
- `aliases`: common abbreviations and alternative spellings
- `flag`: based on CIR/SCCS/EWG consensus
- `reason`: one sentence, factual, citable
- `category`: `'grooming'` or `'both'`
- `fertility_relevant` / `testosterone_relevant`: based on endocrine evidence
- `evidence_url`: link to CIR, SCCS, EWG, or PubMed primary source

**Step 4b — Flag reclassifications (`lib/dictionary/seed.ts`)**

For each ingredient identified in Check B, update `flag`. Create a short decision note inline in the file using a comment. Example:

```ts
// Reclassified caution → negative (grooming) in v1.3 calibration:
// Consistently appeared in high-gap products (present in 18/22 high-gap grooming products).
// EWG score 8/10. EU mandates 80+ allergen sub-components be declared separately.
// Leave-on exposure with undisclosed phthalate/musk risk justifies negative tier.
{
  normalized: 'fragrance',
  aliases: ['parfum', 'perfume'],
  flag: 'negative',
  ...
}
```

**Step 4c — Worst-ingredient cap (`lib/scoring/food-grooming.ts` + `lib/scoring/constants.ts`)**

If the cap mechanism is warranted (Check A), implement as a post-scoring step in `scoreFoodGrooming`. Add the cap thresholds to `constants.ts`:

```ts
export const INGREDIENT_SCORE_CAPS: Record<string, number> = {
  negative: 49,  // Any negative ingredient → Mediocre or worse
  caution:  74,  // Any caution ingredient  → Good or worse (no Excellent)
};
```

Apply after the main deduction loop:

```ts
const worstFlag = flagged.length > 0 ? flagged[0].flag : null;  // sorted worst-first
const cap = worstFlag ? INGREDIENT_SCORE_CAPS[worstFlag] : 100;
const ingredientSafetyScore = Math.min(cap, Math.max(0, raw));
```

This is a significant change: **every grooming product with any caution ingredient becomes ineligible for "Excellent."** Verify this is the intent before implementing.

**Step 4d — Magnitude adjustments (`lib/scoring/constants.ts`)**

Only if Check D identifies a global gap not explained by the above. Adjust specific cells of `FLAG_DEDUCTIONS`. Bump `SCORE_VERSION` to `v1.3.0`.

**Step 4e — Mirror to Expo app**

Per the CLAUDE.md charter and v1.2 report precedent: any change to `FLAG_DEDUCTIONS`, `INGREDIENT_SCORE_CAPS`, or the scoring loop must be mirrored to `constants/Scoring.ts` in the Expo repo in the same PR or a coordinated same-day deploy.

---

### Phase 5 — Rescore and Verify

**5a — Dry run**

```bash
npm run db:rescore -- --dry --category grooming
```

Review the band-transition summary in output. Expected direction: net negative drift in grooming (scores should go down on average).

**5b — Spot-check 10 products manually**

For 10 products from the calibration set, recalculate the expected score by hand against the new constants. Verify the script output matches.

**5c — Production rescore**

```bash
npm run db:rescore -- --category grooming
```

**5d — Post-rescore comparison**

Re-export from `/admin/calibration` (scores will have updated). Recompute gaps. Expected outcome:
- Mean gap reduced by ≥50% of the pre-calibration mean
- Band mismatch rate below 20%
- No product with a `negative` ingredient scoring above 49 (if cap was implemented)

**5e — Commit and document**

Commit all changes in one PR with:
- Updated `SCORE_VERSION` in `constants.ts`
- Updated `scoring.md` reflecting the new algorithm state
- A new section in this document (§7 Calibration Runs) recording the date, products tested, mean gap before/after, and decisions made

---

## 5. Decision Reference

### 5.1 When to reclassify an ingredient

Reclassify `caution` → `negative` when **two or more** of the following are true:

- EWG Skin Deep score ≥ 6 (on their 1–10 hazard scale)
- SCCS or CIR opinion identifies a specific health concern beyond general irritation
- EU has restricted or banned the ingredient in leave-on products
- The ingredient is a confirmed sensitiser (as opposed to a dose-dependent irritant)
- The ingredient hides sub-components with higher risk than the parent entry suggests (Parfum, DEA derivatives)

Do **not** reclassify based on a single source. Consumer advocacy sites that aggregate EWG scores without independent review are not sufficient.

### 5.2 When to add vs reclassify a missing ingredient

- **Add as `neutral`:** ingredient is well-characterised, widely reviewed, no safety concerns in the literature (e.g., glycerin, panthenol, cetyl alcohol)
- **Add as `caution`:** ingredient has dose-dependent or context-dependent concerns, or is on a precautionary watch list (e.g., ethoxylated compounds, isopropyl alcohol at high concentrations)
- **Add as `negative`:** ingredient is restricted or banned by a major regulatory body, is a confirmed endocrine disruptor, or is a confirmed sensitiser at any concentration

### 5.3 Worst-ingredient cap — when to implement

Implement the cap when the data shows that products with flagged ingredients are systematically scoring in a band that implies safety to users who would not otherwise select that product. Concretely:

- If products with Parfum (acknowledged phthalate risk) score "Excellent" → implement cap
- If products with SLS in a leave-on formulation score "Good" → implement cap for negative tier at minimum

The cap is the most conservative of the available levers. It will move scores down even for otherwise clean products. Confirm the product team is aligned before implementing.

### 5.4 When NOT to change the algorithm

- Do not adjust magnitudes to match Yuka on a product-by-product basis. Chasing individual scores defeats the purpose of a principled model.
- Do not downgrade an ingredient's flag to close a gap where ManGood scores *lower* than Yuka. Our model may be more conservative and that is acceptable.
- Do not add positive-flag credit to the numeric score. The v1.2 report permanently closed this design choice.

---

## 6. Version History

| Version | Date | Summary |
|---|---|---|
| v1.2.0 | 2026-04-12 | Subtract-only model. Dropped positive flag contributions to score. |
| v1.3.0 | TBD | Pending calibration exercise — see Phase 4 above. |

---

## 7. Calibration Runs

### Run 1 — April 2026

**Status:** In progress
**Products:** ~30 grooming products (shaving cream, aftershave, soap, shampoo)
**Reference benchmark:** Yuka mobile app
**Tool:** `/admin/calibration` page
**Pre-calibration mean gap:** TBD
**Decisions:** TBD
**Post-calibration mean gap:** TBD

*(Update this section after completing Phase 5.)*

---

## 8. External References

| Source | URL | Used for |
|---|---|---|
| EU Cosmetics Ingredient database (CosIng) | https://ec.europa.eu/growth/tools-databases/cosing/ | Flag decisions, concentration limits |
| SCCS (Scientific Committee on Consumer Safety) | https://health.ec.europa.eu/scientific-committees/scientific-committee-consumer-safety-sccs_en | EU regulatory opinions |
| CIR (Cosmetic Ingredient Review) | https://www.cir-safety.org/ingredients | US industry safety reviews |
| EWG Skin Deep | https://www.ewg.org/skindeep/ | Reference benchmark (consumer-facing) |
| EU Cosmetics Regulation 1223/2009 | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009R1223 | INCI list ordering requirement |
| EU Regulation 2023/1545 (fragrance allergens) | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1545 | 80+ declarable fragrance allergens |
| IARC Monographs | https://monographs.iarc.who.int/ | Carcinogenicity classifications |
| EPA 1,4-Dioxane | https://www.epa.gov/sites/default/files/2016-09/documents/1-4-dioxane.pdf | Contamination risk in ethoxylated ingredients |
| INCI Beauty methodology | https://incibeauty.com/en/blog/how-does-our-ingredient-analysis-work | Competitor methodology reference |
