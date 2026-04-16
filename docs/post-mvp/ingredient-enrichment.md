# Ingredient Enrichment: Rich Detail Pages

> **Status:** Proposal (revised 2026-04-16)
> **Created:** 2026-04-15
> **Depends on:** None (additive to current dictionary)
> **Blocked by:** Nothing shipped — can start immediately

## Problem

Today each ingredient in the dictionary carries a single-sentence `reason` field ("Surfactant — known skin and eye irritant at high concentrations") and one `evidence_url`. Competitors like Yuka display multi-paragraph detail pages with:

- Ingredient family/group ("Sulfates")
- Visual health-risk tags ("Irritant", "Endocrine Disruptor")
- 3-4 paragraph consumer-facing description covering what-it-is, health effects, regulatory context, and concentration nuance
- Multiple cited sources

Users who tap on a flagged ingredient currently get a tooltip-level explanation. We want a full detail sheet.

---

## Proposed Changes

### 1. Database Schema

Schema changes are split across phases to keep each migration small and shippable.

**Phase 1 migration** — add two columns to `ingredient_dictionary`:

```sql
ALTER TABLE ingredient_dictionary
  ADD COLUMN ingredient_group TEXT,                -- "Sulfates", "Parabens", "Synthetic Dyes"
  ADD COLUMN health_risk_tags TEXT[] DEFAULT '{}';  -- {"irritant", "endocrine_disruptor"}
```

**Phase 3 migration** (added later when descriptions are ready):

```sql
ALTER TABLE ingredient_dictionary
  ADD COLUMN description TEXT,                     -- multi-paragraph detail body
  ADD COLUMN evidence_sources JSONB DEFAULT '[]';  -- [{url, label, type}]
```

The existing `evidence_url` and `notes` columns are retained. `evidence_url` continues to serve as the single citation until Phase 3 introduces `evidence_sources` for multi-source descriptions.

#### `ingredient_group` values (~25 groups)

| Group | Example ingredients |
|---|---|
| Sulfates | sodium lauryl sulfate, sodium laureth sulfate |
| Parabens | methylparaben, propylparaben, butylparaben |
| Phthalates | diethyl phthalate, dibutyl phthalate |
| Formaldehyde Releasers | DMDM hydantoin, quaternium-15, imidazolidinyl urea |
| Synthetic Dyes | red 40, yellow 5, blue 1 |
| UV Filters (Chemical) | oxybenzone, octinoxate, avobenzone |
| UV Filters (Mineral) | titanium dioxide, zinc oxide |
| Seed Oils | soybean oil, canola oil, corn oil, sunflower oil |
| Artificial Sweeteners | aspartame, acesulfame potassium, sucralose |
| Emulsifiers | polysorbate 80, carboxymethylcellulose |
| Preservatives | phenoxyethanol, methylisothiazolinone |
| Silicones | dimethicone, cyclomethicone |
| Antioxidants (Synthetic) | BHA, BHT, TBHQ |
| Adaptogens | ashwagandha, maca, tongkat ali |
| B Vitamins | vitamin B6, vitamin B12, folate, biotin |
| Minerals | zinc, magnesium, selenium, boron, iron, calcium |
| Omega Fatty Acids | omega-3, flax seed, chia seeds |
| Plant Extracts | aloe vera, centella asiatica, tea tree oil |
| Humectants | hyaluronic acid, glycerin, panthenol |
| Emollients | shea butter, jojoba oil, squalane, argan oil |
| Proteins | whey protein, collagen/gelatin |
| Sugars & Sweeteners | sugar, HFCS, corn syrup, dextrose, maltodextrin |
| Phosphates | sodium phosphate |
| Thickeners & Gums | carrageenan, xanthan gum, pectin |
| Fragrance | fragrance/parfum |

#### `health_risk_tags` controlled vocabulary

| Tag | Meaning | Icon hint |
|---|---|---|
| `irritant` | Skin, eye, or scalp irritation | Exclamation |
| `endocrine_disruptor` | Hormonal interference | Hormone symbol |
| `carcinogen` | Cancer-related evidence (IARC or equivalent) | Hazard |
| `allergen` | Contact allergy or sensitization | Allergy |
| `organ_toxicant` | Liver, kidney, or neurotoxicity | Organ |
| `environmental` | Reef or ecosystem harm | Leaf |
| `gut_disruptor` | Microbiome or GI inflammation | Gut |
| `reproductive_toxin` | Fertility or developmental effects | Fertility |

Most ingredients carry 1-2 tags. Mapping from existing seed data:

| Seed `reason` pattern | Maps to |
|---|---|
| "irritant", "irritating", "drying" | `irritant` |
| "endocrine", "estrogenic", "anti-androgenic", "hormonal" | `endocrine_disruptor` |
| "carcinogenic", "IARC", "tumor" | `carcinogen` |
| "allergen", "sensitizer", "allergic" | `allergen` |
| "neurotoxic", "organ", "liver", "kidney" | `organ_toxicant` |
| "reef", "environmental", "persistence" | `environmental` |
| "gut", "microbiome", "GI inflammation" | `gut_disruptor` |
| "fertility", "sperm", "reproductive" | `reproductive_toxin` |

#### `evidence_sources` shape (Phase 3)

When descriptions land in Phase 3, each ingredient gains an `evidence_sources` JSONB array:

```json
[
  {
    "url": "https://www.cir-safety.org/ingredients",
    "label": "CIR Safety Assessment",
    "type": "regulatory"
  },
  {
    "url": "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    "label": "Smith et al. 2019",
    "type": "study"
  }
]
```

`type` enum: `"regulatory"` | `"study"` | `"review"` | `"database"`

Until Phase 3, the existing `evidence_url` string field serves as the single citation.

### 2. In-Memory Seed Changes

**Phase 1** — extend `DictionaryEntry` in `lib/dictionary/seed.ts` with two fields:

```typescript
export type DictionaryEntry = {
  normalized: string;
  aliases: string[];
  flag: IngredientFlag;
  reason: string;                         // keep — 1-liner for scan result cards
  category: 'food' | 'grooming' | 'supplement' | 'both';
  ingredient_group: string;               // NEW (Phase 1)
  health_risk_tags: string[];             // NEW (Phase 1)
  fertility_relevant: boolean;
  testosterone_relevant: boolean;
  evidence_url: string;
};
```

**Phase 3** — add `description` and `evidence_sources` when descriptions are ready:

```typescript
  description: string | null;             // NEW (Phase 3) — null until enriched
  evidence_sources: EvidenceSource[];     // NEW (Phase 3)
```

```typescript
export type EvidenceSource = {
  url: string;
  label: string;
  type: 'regulatory' | 'study' | 'review' | 'database';
};
```

### 3. API Surface

New endpoint: `GET /api/ingredients/:normalized`

The client already has `flag`, `reason`, `fertility_relevant`, and `testosterone_relevant` from the scan result's `Ingredient` type. The detail endpoint returns only the enrichment fields to avoid two sources of truth:

```typescript
// types/guardscan.ts
export type IngredientDetail = {
  normalized: string;
  display_name: string;
  ingredient_group: string;
  health_risk_tags: string[];
  description: string | null;     // null until Phase 3 enrichment
  evidence_url: string;           // existing citation (Phase 3 adds evidence_sources)
};
```

The Expo app taps an ingredient in the scan result list -> calls this endpoint -> renders the detail sheet. If `description` is null, the app shows only the `reason` sentence from the scan result (graceful degradation).

### 4. Description Text Format

Plain text with `\n\n` paragraph breaks. No markdown, no HTML. The Expo app handles section headers ("Health Risks", "Details", "Sources") in native UI.

**Paragraph structure (3-4 paragraphs):**

1. **What it is** — functional role, where it's commonly found
2. **Health evidence** — what studies show, at what exposure or concentration
3. **Regulatory context** — CIR, SCCS, EFSA, FDA, IARC positions
4. **Usage nuance** (optional) — concentration thresholds, rinse-off vs. leave-on, etc.

**Example (sodium lauryl sulfate):**

```
Sodium lauryl sulfate is a surfactant, a highly effective cleaning and foaming agent used in shampoos, body washes, and toothpastes. It is one of the most widely used detergents in personal care products.

It has been shown to cause irritation to the skin, eyes, and scalp, particularly at higher concentrations or with prolonged contact. Some studies also report mild inflammatory effects on the skin barrier.

By disrupting the lipid layer of the skin, SLS may increase the penetration of other ingredients, including potentially harmful ones. This is why its presence in leave-on products is more concerning than in rinse-off formulations.

The Cosmetic Ingredient Review (CIR) panel considers SLS safe for brief use followed by thorough rinsing. For leave-on products, the CIR recommends concentrations not exceeding 1%. The EU SCCS has not set a specific limit but acknowledges the irritation potential.
```

---

## Data Sourcing Strategy

### Source Audit Results

We evaluated five data sources for their suitability to populate the `description`, `health_risk_tags`, and `evidence_sources` fields. Results below are based on known API/content structures (live verification recommended before implementation — see Phase 0).

#### PubChem PUG View API — PRIMARY for health_risk_tags

| Attribute | Assessment |
|---|---|
| **Coverage** | Individual chemical compounds (not mixtures like "fragrance") |
| **Data quality** | GHS hazard statements (H-codes), signal words, NFPA ratings |
| **API** | Free REST API, no key required, 5 req/sec limit |
| **Consumer text** | None — structured hazard codes only |
| **Cost** | Free |
| **Verdict** | Best source for automated `health_risk_tags` extraction |

**Key endpoint:**
```
GET https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/{CID}/JSON?heading=Safety+and+Hazards
```

**GHS H-code → risk tag mapping:**

| H-Code | GHS Statement | GuardScan Tag |
|---|---|---|
| H315 | Causes skin irritation | `irritant` |
| H317 | May cause allergic skin reaction | `allergen` |
| H318 | Causes serious eye damage | `irritant` |
| H335 | May cause respiratory irritation | `irritant` |
| H340 | May cause genetic defects | `carcinogen` |
| H350 | May cause cancer | `carcinogen` |
| H360 | May damage fertility | `reproductive_toxin` |
| H361 | Suspected of damaging fertility | `reproductive_toxin` |
| H370/H372 | Causes organ damage | `organ_toxicant` |
| H400/H410/H411 | Toxic to aquatic life | `environmental` |

**Caveat:** GHS classifications describe the pure chemical, not cosmetic-grade concentrations. We apply our own concentration-awareness in the description text.

**Name resolution issue:** INCI cosmetic names (e.g., "Cetearyl Alcohol") don't always resolve in PubChem. Estimated ~70% of our dictionary entries will resolve cleanly. For the remaining ~30%, we'll need manual CID mapping or fallback to our existing curated data.

#### PubMed E-utilities API — PRIMARY for evidence_sources

| Attribute | Assessment |
|---|---|
| **Coverage** | All biomedical literature; best for supplements and food additives |
| **Data quality** | Structured abstracts with conclusion sentences; MeSH terms |
| **API** | Free (3 req/sec without key, 10 req/sec with free API key) |
| **Consumer text** | Abstracts provide extractable findings for LLM-generated descriptions |
| **Cost** | Free |
| **Verdict** | Best source for citations and evidence-backed description drafting |

**Key endpoints:**
```
# Resolve PMID from our existing evidence_url
GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id={PMID}&rettype=abstract&retmode=xml

# Find systematic reviews for an ingredient
GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={ingredient}+review&rettype=json
```

**Workflow:** Extract PMIDs from existing `evidence_url` fields → fetch structured abstracts → feed to LLM alongside regulatory source text → generate description paragraphs → human review.

#### CIR (Cosmetic Ingredient Review) — REFERENCE for grooming descriptions

| Attribute | Assessment |
|---|---|
| **Coverage** | ~1,300+ cosmetic ingredient groups |
| **Data quality** | Gold-standard safety conclusions with concentration limits |
| **API** | None — web-only, PDF reports |
| **Consumer text** | Safety conclusions are paraphrasable for consumer descriptions |
| **Cost** | Free to access |
| **Verdict** | Essential reference for grooming ingredient regulatory context |

**URL pattern:** `https://www.cir-safety.org/ingredients` (searchable database)

**Usage:** Manual lookup during description drafting. CIR conclusions go into paragraph 3-4 of descriptions. In Phase 3, store URL in `evidence_sources` with `type: "regulatory"`.

#### EFSA — REFERENCE for food additive descriptions

| Attribute | Assessment |
|---|---|
| **Coverage** | EU food additives (E-numbers), some controversial ingredients have dedicated topic pages |
| **Data quality** | ADI values, safety opinions, re-evaluation conclusions |
| **API** | None — EFSA Journal articles are open-access PDFs |
| **Consumer text** | Topic pages have consumer-friendly summaries (only for ~20-30 major additives) |
| **Cost** | Free |
| **Verdict** | Reference for food additive regulatory context; limited programmatic use |

**URL patterns:**
- Topic pages: `https://www.efsa.europa.eu/en/topics/topic/{slug}` (limited coverage)
- EFSA Journal: `https://efsa.onlinelibrary.wiley.com/doi/10.2903/j.efsa.{year}.{number}` (stable DOIs)

**Usage:** Cite ADI values and safety conclusions in food additive descriptions. In Phase 3, link to EFSA Journal opinions in `evidence_sources`.

#### EWG Skin Deep — REFERENCE for risk category taxonomy

| Attribute | Assessment |
|---|---|
| **Coverage** | Comprehensive cosmetic ingredient database |
| **Data quality** | Per-category hazard scores (1-10), health concern categories |
| **API** | None — no public API, ToS prohibits scraping |
| **Consumer text** | Has consumer-facing explanations |
| **Cost** | Free to view |
| **Verdict** | Use their category taxonomy as inspiration; do NOT copy scores |

**What we take from EWG:** Their risk category taxonomy (irritation, organ toxicity, allergen, etc.) informed our `health_risk_tags` vocabulary. We do not copy their numerical scores or text.

**What we link to:** In Phase 3, EWG ingredient pages can be included in `evidence_sources` as `type: "database"` for user reference.

### Source Coverage by Ingredient Category

| Category | Primary Source | Secondary Source | Regulatory Source |
|---|---|---|---|
| **Grooming** (negative/caution) | PubChem (GHS H-codes) | PubMed (studies) | CIR, SCCS |
| **Food** (negative/caution) | PubChem (GHS H-codes) | PubMed (studies) | EFSA, FDA |
| **Supplement** (positive) | PubMed (clinical trials) | -- | NIH ODS, FDA |
| **Cross-category** (neutral) | PubChem (safety data) | -- | CIR/EFSA as applicable |

---

## Implementation Plan

### Phase 0: Live Source Verification (1 day) — DONE

**Script:** `scripts/audit-ingredient-sources.ts` — run via `npx tsx scripts/audit-ingredient-sources.ts`

**Results (2026-04-16):**

| Ingredient | PubChem | PubMed | Notes |
|---|---|---|---|
| sodium lauryl sulfate | PASS | PASS | CID 3423265, 15 H-codes (8 mapped) |
| aspartame | PASS | PASS | CID 134601, 0 H-codes (approved food additive) |
| ashwagandha | FAIL | PASS | Common name fails; fallback "withaferin A" → CID but no GHS data |

**Go/no-go: PASS** (2/3 PubChem checks passed). Key learnings:
- Chemical compounds (grooming) resolve perfectly with rich GHS data
- Food additives resolve to CIDs but have minimal/no GHS hazard classifications
- Botanicals/supplements need manual CID mapping (~30% of dictionary)

### Phase 1: Schema + Seed Metadata (1-2 days)

**Changes:**
1. Drizzle migration: add `ingredient_group TEXT` and `health_risk_tags TEXT[]` to `ingredient_dictionary`
2. Extend `DictionaryEntry` type with `ingredient_group` and `health_risk_tags` (two fields only)
3. Populate `ingredient_group` for all ~300 seed entries (mechanical — map from existing comment headers in `seed.ts`)
4. Populate `health_risk_tags` for all entries (semi-automated — parse `reason` text for keyword patterns, then manual review)

No `description` or `evidence_sources` fields yet — those are deferred to Phase 3 when descriptions are actually written. This keeps the migration small and the seed type changes minimal.

**What ships:** The detail endpoint can immediately return `ingredient_group` and `health_risk_tags` alongside existing data. The Expo app can render group labels and risk tag icons without waiting for full descriptions.

### Phase 2: PubChem Enrichment Script (1-2 days)

**Script:** `scripts/enrich-pubchem.ts`

```
For each seed entry:
  1. Resolve ingredient name → PubChem CID (cache CID in seed)
  2. Fetch GHS hazard statements via PUG View
  3. Map H-codes → health_risk_tags
  4. Compare with manually-assigned tags from Phase 1
  5. Output discrepancy report for human review
  6. Store PubChem CID for future lookups
```

Rate limit: 5 req/sec → ~300 ingredients takes ~60 seconds.

**What ships:** Validated `health_risk_tags` with PubChem backing. PubChem CIDs cached for Phase 3 description generation.

### Phase 3: Description Generation (3-5 days)

**DB migration:** Add `description TEXT` and `evidence_sources JSONB DEFAULT '[]'` columns. Extend `DictionaryEntry` type with `description: string | null` and `evidence_sources: EvidenceSource[]`. These columns were intentionally deferred from Phase 1 to avoid empty columns sitting in the DB.

**Priority tiers:**
- **Tier 1 (ship first):** All `negative` and `caution` ingredients (~50 entries) — these are what users tap on
- **Tier 2:** Common `positive` ingredients (~30 entries) — user curiosity
- **Tier 3:** Remaining positive + neutral entries

**Workflow per ingredient:**

1. Gather source material:
   - PubChem safety data (from Phase 2)
   - PubMed abstract for existing `evidence_url` PMID
   - 1-2 additional PubMed systematic reviews (searched via E-utilities)
   - CIR/EFSA/FDA regulatory page (manual lookup)

2. Feed to Claude with prompt template:
   ```
   Write a 3-4 paragraph consumer-facing description of [ingredient].
   Paragraph 1: What it is and what it does.
   Paragraph 2: Known health effects with evidence level.
   Paragraph 3: Regulatory status (CIR, SCCS, EFSA, FDA, IARC).
   Paragraph 4 (if applicable): Concentration or usage nuance.
   Use these sources: [source material].
   Do not copy text verbatim. Cite specific sources.
   ```

3. Human review for accuracy and tone

4. Store in `description` field with populated `evidence_sources` array

**Script:** `scripts/generate-descriptions.ts` — batch generates draft descriptions, outputs to a review file for human sign-off before committing to seed.

### Phase 4: API Endpoint + Expo Integration (1 day)

1. Add `GET /api/ingredients/:normalized` route
2. Add `IngredientDetail` type to `types/guardscan.ts`
3. Coordinate with Expo app for detail sheet UI

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| PubChem name resolution fails for INCI names | Maintain manual CID mapping table; ~30% of entries may need manual lookup |
| GHS H-codes describe pure chemical, not cosmetic-grade concentration | Description text includes concentration nuance; tags reflect inherent hazard, not use-level risk |
| LLM-generated descriptions contain errors | Mandatory human review before publishing; start with Tier 1 only |
| EWG ToS prohibits data copying | We reference their taxonomy conceptually; no numerical scores or text are copied |
| Source websites restructure | All URLs stored in `evidence_url` (and later `evidence_sources`) — broken links detectable via periodic link-checker script |
| Scope creep into "full Yuka clone" | Phase 1-2 ship independently without descriptions; Phase 3 is incremental |

---

## Scoring Impact Assessment

**This proposal does not change the scoring algorithm (v1.2.0).** Scoring remains `flag` + `position` based with life-stage multipliers. However, the enriched data introduces three considerations that should be documented now to avoid conflicting decisions later.

### 1. Risk Tags Expose Severity Gaps in the Current Flag System

Today, all `caution` ingredients receive the same deduction (-8/-5/-3 by position). But with `health_risk_tags` visible to users, the gap becomes obvious:

| Ingredient | Flag | Risk Tags | Deduction (pos 1) |
|---|---|---|---|
| Sodium lauryl sulfate | caution | `irritant` | -8 |
| Fragrance | caution | `endocrine_disruptor`, `allergen` | -8 |
| Octocrylene | caution | `endocrine_disruptor` | -8 |

A user seeing "endocrine disruptor" tagged on an ingredient that scores the same as "irritant" may lose trust. This is an information-vs-scoring consistency issue.

**Decision for now:** Accept the gap. The `flag` represents the overall verdict (caution vs negative), while `health_risk_tags` explain the *type* of concern. These are different axes. The description text can add nuance that the score alone cannot (e.g., "at cosmetic-grade concentrations, the endocrine effect is minimal").

**Future option (v1.3.0):** Introduce tag-weighted deductions. Example: `caution` + `endocrine_disruptor` → -10 instead of -8. This would require versioning the scoring algorithm, re-scoring all cached products, and coordinating with the Expo app's mirrored constants. Out of scope for this proposal.

### 2. PubChem GHS Data May Pressure-Test Flag Assignments

Phase 2 fetches GHS hazard classifications from PubChem. These are based on the pure chemical, not cosmetic-grade concentrations — but they may surface inconsistencies with our current flag assignments:

- An ingredient we flagged `caution` might carry GHS H350 ("May cause cancer") → suggests it should be `negative`
- An ingredient we flagged `negative` might have no GHS hazard statements → suggests our flag may be overly conservative

**Action item (Phase 2 output):** The enrichment script should output a **flag discrepancy report** comparing our assigned flag against what the GHS data implies. This report is reviewed by a human before any flag changes are made. Flag changes are a scoring change and would bump the version to v1.2.1.

### 3. Ingredient Group Opens Future Cumulative Scoring

With `ingredient_group`, we could detect that a product contains 3 parabens (methylparaben + propylparaben + butylparaben) and apply a cumulative-exposure penalty beyond the sum of individual deductions. The current algorithm treats each ingredient independently.

**Decision for now:** Do not change scoring. Cumulative scoring is a v2.0 concept that requires research into additive toxicology evidence. But storing `ingredient_group` now means we have the data when we're ready.

### Summary

| Concern | This Proposal | Future Scoring Change |
|---|---|---|
| Tag-severity gap (caution irritant = caution endocrine) | Accept; description text provides nuance | v1.3.0: tag-weighted deductions |
| Flag-GHS inconsistencies | Phase 2 outputs discrepancy report for human review | v1.2.1: re-classify flagged ingredients |
| Cumulative group exposure | Store `ingredient_group` for future use | v2.0: group-level penalty |

**Principle:** Enrichment is an information layer. Scoring is a separate concern with its own versioning, Expo app coordination, and re-scoring implications. This proposal intentionally avoids coupling the two so both can evolve independently.

---

## Non-Goals

- We are **not** building a PubChem/PubMed scraping pipeline that runs on every scan. All enrichment is batch-processed and stored in the seed/database.
- We are **not** auto-generating descriptions without human review.
- We are **not** copying EWG scores or Yuka text.
- We are **not** changing the scoring algorithm — this is purely an information display enhancement. See "Scoring Impact Assessment" above for future scoring implications.

---

## Estimated Effort

| Phase | Effort | DB changes | Can ship independently? |
|---|---|---|---|
| Phase 0: Source verification | 1 day | None | N/A (go/no-go gate) — **DONE** |
| Phase 1: Schema + seed metadata | 1-2 days | 2 cols: `ingredient_group`, `health_risk_tags` | Yes — enables risk tags + groups immediately |
| Phase 2: PubChem enrichment | 1-2 days | None | Yes — validates/augments Phase 1 tags |
| Phase 3: Description generation | 3-5 days | 2 cols: `description`, `evidence_sources` | Yes — Tier 1 first, then Tier 2-3 |
| Phase 4: API endpoint | 1 day | None | Requires Phase 1+ |
| **Total** | **7-11 days** | 4 cols across 2 migrations | Phases 1+4 are the minimum viable delivery |
