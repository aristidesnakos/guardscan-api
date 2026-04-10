# GuardScan API — Roadmap

## M1 — Schema + Scan via OFF ✅

Barcode lookup endpoint (`GET /api/products/scan/:barcode`) backed by Open Food Facts. Optional DB cache via Supabase Postgres. Ingredient scoring as a pure function. Food + grooming categories only.

**Exit criteria:** Scan of a known OFF barcode (e.g. Nutella `3017620422003`) returns a scored `ScanResult` with image, ingredients, and computed score.

**Delivered:**
- Scan endpoint live at `https://guardscan-api.vercel.app`
- Supabase Postgres (US East) connected via Transaction pooler
- DB schema applied (4 tables: `products`, `product_ingredients`, `ingredient_dictionary`, `user_submissions`)
- Background cache writes via `after()`
- CORS proxy (`proxy.ts`) for Expo Web / browser clients
- Deployed on Vercel Fluid Compute, region `iad1`

**Still pending for M1 hardening:**
- `SUPABASE_JWT_SECRET` — needed for Bearer token verification (see setup below)

### Setting up `SUPABASE_JWT_SECRET`

This secret lets the API verify Bearer tokens issued by Supabase Auth in the Expo app. Not used yet in M1 (auth is disabled), but required for M1.5.

1. **Supabase Dashboard** → Settings → API → scroll to **JWT Settings**
2. Copy the **JWT Secret** (this is the signing secret, NOT the `anon` key or `service_role` key)
3. Add to your local `.env`:
   ```
   SUPABASE_JWT_SECRET=your-jwt-secret-here
   ```
4. Add to Vercel:
   ```bash
   vercel env add SUPABASE_JWT_SECRET
   # Paste the JWT secret when prompted
   # Select: Production, Preview, Development
   ```
5. Set `AUTH_ENABLED=true` when ready to enforce auth (M1.5)

---

## M1.5 — Multi-Source Scanning + Dictionary Growth

> **Implementation plan:** [M1.5-MULTI-SOURCE-SCANNING.md](./M1.5-MULTI-SOURCE-SCANNING.md)

Add Open Beauty Facts (OBF) for grooming products and DSLD adapter for supplements. Expand ingredient dictionary from ~60 to ~300 curated entries covering grooming and supplement compounds. Scan route tries OFF + OBF in parallel; supplements resolve from DB cache (populated by M2 sync).

**Exit criteria:** OBF grooming barcodes resolve and score. Dictionary covers top grooming + supplement compounds. Supplements resolve from DB when pre-populated.

---

## M2 — Cron Ingest (OBF + DSLD)

> **Implementation plan:** [M2-CRON-INGEST.md](./M2-CRON-INGEST.md)

Automated ingest workers on Vercel Cron that keep the product catalog growing:

| Job | Schedule | Source |
|---|---|---|
| `obf-delta` | Daily (`0 3 * * *`) | OBF daily delta JSONL — upsert changed grooming barcodes |
| `dsld-sync` | Weekly (`0 5 * * 0`) | DSLD supplement labels with valid UPCs |
| `seed-grooming` | Once (manual) | Top ~200 men's grooming SKUs by brand via OBF search |

**Exit criteria:** DB grows automatically from OBF/DSLD updates without manual intervention. Grooming seed populates ~200 products.

---

## M2.5 — Recommendations Backing API

> **Implementation plan:** [M2.5-RECOMMENDATIONS-API.md](./M2.5-RECOMMENDATIONS-API.md)

Replace the Expo app's mock recommendations with real backend endpoints. Subcategory inference clusters products for relevant alternative matching. Scan events track user history for personalized recommendations.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/recommendations` | `RecommendationPair[]` — user's Poor/Mediocre scans paired with best alternatives |
| GET | `/api/products/:id/alternatives` | `ProductAlternative[]` — same-subcategory products scoring 15+ points higher |

**Exit criteria:** Expo `getRecommendations` / `getAlternatives` return real data. `EXPO_PUBLIC_USE_MOCK_API` can be set to `false` for recommendations.

---

## M3 — User Submissions + OCR Pipeline

> **Implementation plan:** [M3-USER-SUBMISSIONS.md](./M3-USER-SUBMISSIONS.md)

User-submitted photos (front label + ingredient panel) for missing barcodes. Phased approach: M3.0 manual review, M3.1 auto-OCR with Claude Vision, M3.2 community quality control. **Primary growth mechanism** for grooming catalog where OBF coverage is sparse.

**Three-phase approach:**

| Phase | Timeline | Tech | Admin Role | User Latency | Cost |
|---|---|---|---|---|---|
| **M3.0** | Week 2–3 | Manual extraction | Reviews all | 24–48h | $0 |
| **M3.1** | Week 4–5 | Claude Vision | Spot-checks 10% | <1h (auto-publish) | ~$0.20/sub |
| **M3.2** | Month 2+ | Claude + voting | Quality audit | Real-time | ~$0.20/sub |

**Why phased:**
- M3.0 validates user submission UX before engineering OCR automation
- By M3.1, you have 50–100 real submission examples to test OCR accuracy against
- No product catalog gets published with bad data during MVP ramp-up
- Admin bottleneck is minimal (light spot-checking, not full review)

**Why Claude Vision over Google Vision:**
- Contextual understanding of ingredient list structure (vs. raw text extraction)
- Confidence scoring for semantic decisions (Claude returns "I'm 92% confident")
- Better at handling messy formats (columns, small text, allergen callouts)
- Cheaper at MVP scale (~$0.15–0.30/submission) + easier to iterate (prompt-based)

**Exit criteria (M3.0):** User can submit front + back photos; admin reviews and publishes to catalog within 24 hours. Next scan of same barcode hits DB cache (no 404).

---

## M4 — Search Endpoint

Full-text + filtered search (`GET /products?q=&category=&score=&cursor=`). Cursor-paginated. Powers the Expo `/(tabs)/search` screen.

**Exit criteria:** Search tab populated from backend with working filters.

---

## M5 — Commercial Fallback

Evaluate and integrate a commercial barcode provider (e.g. Nutritionix for food) as a fallback when OBF/OBF/DSLD miss. Gated by `PROVIDER_FALLBACK_ENABLED` env var.

**Exit criteria:** Cold barcode lookups that miss open sources fall through to commercial provider before returning 404.

---

## M6 — User Submissions + OCR (Extended)

Enhanced submission pipeline, admin tooling, and catalog quality improvements.

**Exit criteria:** End-to-end submission flow stable in production with acceptable OCR accuracy.
