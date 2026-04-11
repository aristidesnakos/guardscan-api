# OCR Confidence Threshold Tuning Charter

**Purpose:** Collect empirical data on Claude Vision OCR confidence and quality to inform auto-publish threshold adjustments in M2+.

**Current state:** `AUTO_PUBLISH_CONFIDENCE_THRESHOLD = 85` (conservative, tuned on grooming images only).

---

## Data Collection Plan (MVP)

### Task A: Triage 8 pending submissions

For each submission, record:

| Field | Values | Notes |
|---|---|---|
| **Submission ID** | UUID | From user_submissions.id |
| **Confidence** | 0–100 | From ocr_text.confidence |
| **Category** | food/grooming/supplement | From ocr_text.category |
| **Completeness** | name + brand + category + 2+ ingredients? | All required fields present? |
| **OCR quality** | good / acceptable / poor | Based on `notes` (blurriness, obscuring, languages, etc.) |
| **Duplicate?** | yes / no | Barcode already in products table? |
| **Decision** | publish / reject | Manual triage call |
| **Would auto-publish?** | yes / no | confidence >= 85 AND no quality issues? |

### Recording template

Create `docs/submissions-triage-mvp.md` with a table like:

```
| ID (first 8 chars) | Conf | Cat | Complete | Quality | Dup? | Decision | Would auto? |
|---|---|---|---|---|---|---|---|
| aef6e6eb | 52 | grooming | ✅ | poor | ❌ | publish | ❌ |
| ... | | | | | | | |
```

---

## Analysis (post-triage, still MVP)

After all 8 are triaged, compute:

1. **Confidence distribution:**
   - Min, max, median, mean
   - How many >= 85? >= 75? >= 60?

2. **Category breakdown:**
   - Confidence by category (grooming vs supplement vs food)
   - Are supplements systematically lower?

3. **Quality vs confidence correlation:**
   - Do "poor" OCR submissions have lower confidence?
   - Is confidence a reliable proxy for quality?

4. **Auto-publish accuracy:**
   - Of submissions where `confidence >= 85`, how many were "good" quality?
   - False positive rate (high confidence but poor quality)?

---

## Decision criteria for M2 tuning

**Do NOT adjust threshold in MVP.** Instead:

- **If 0/8 would auto-publish:** threshold is too high. Consider 75–80 in M2.
- **If 1–3/8 would auto-publish:** threshold is reasonable. Keep at 85.
- **If 4+/8 would auto-publish:** threshold is too low. Consider 90–95 in M2.

**Quality matters more than quantity.** If auto-published submissions have high error rates (poor OCR despite high confidence), consider:
- Tightening threshold further (90+)
- Adding secondary gate: `ocr_quality_score` based on notes analysis
- Deferring auto-publish until on-device image cropping ships (M3.2)

---

## Kill switch usage (MVP testing)

The `AUTO_PUBLISH_ENABLED` env var is a safety valve, not a tuning knob:

- **Task C (preview deploy):** Set to `true`, observe OCR quality on grooming + supplement test cases
- **If OCR breaks or produces garbage:** Set to `false`, use manual CLI review
- **Never** lower threshold as a workaround for low-quality OCR

---

## Reference

- [MVP sprint plan](./mvp-sprint-plan.md#task-a--cli-triage-helpers--disposition-8-submissions)
- [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts) — `AUTO_PUBLISH_CONFIDENCE_THRESHOLD`
- [docs/post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) — related work on supplement handling
