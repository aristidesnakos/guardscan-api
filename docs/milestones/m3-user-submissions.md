# M3 — User Submissions Pipeline (Backend)

**Status:** M3.0 shipped · M3.1 shipped · M3.2 deferred (Expo-side)
**Depends on:** M2 (catalog seeded, cron ingest running)
**Scope:** Backend only. Expo client UX lives in [cucumberdude/docs/product/USER-SUBMISSIONS-UX.md](../../cucumberdude/docs/product/USER-SUBMISSIONS-UX.md) and shipped implementation notes in [cucumberdude/docs/product/SUBMISSION-FLOW-IMPL.md](../../cucumberdude/docs/product/SUBMISSION-FLOW-IMPL.md).
**Exit criteria (M3.0):** User can submit front + back photos of an unknown product; Claude Vision pre-extracts metadata + ingredients; admin verifies and publishes via CLI within 24 hours.
**Exit criteria (M3.1):** Submissions where Claude confidence ≥85 and all guardrails pass (`name`, `category`, ≥2 ingredients) are published straight into the catalog inside the submit request — no admin action required. Lower-confidence or guardrail-failing submissions fall back to the CLI admin tool.

---

## Goal

Let users contribute missing products to the catalog by photographing the front label (product metadata) and back label (ingredient panel). This is the **primary long-term growth mechanism** for grooming catalog coverage — Open Beauty Facts has sparse data and commercial providers are expensive.

The pipeline evolves across phases:
- **M3.0:** Submission endpoint + Supabase Storage + Claude Opus 4.6 pre-fill + CLI admin review
- **M3.1:** Auto-publish at confidence ≥ 85% (removes admin from the loop for clean submissions)
- **M3.2 (polish):** On-device product detection + auto-crop before upload (competitor-grade capture UX, tighter OCR input)

---

## Design Principles

### 1. Two-photo flow (front + back)

- **Front photo** → product name, brand, category hint, catalog display image
- **Back photo** → ingredient panel for extraction

Rationale: guided two-step capture increases photo quality vs. "send any photo," and separating the jobs lets us feed each into Claude with a targeted prompt. This matches Yuka's proven UX pattern (see `docs/scanning-desired/`).

### 2. OCR pre-fill from day one

Original plan treated OCR as an "M3.1 optimization." That's wrong for a solo operator: manual ingredient transcription is 2–5 minutes per submission and dominates review time. **Even in M3.0, Claude Vision pre-fills the review form** — the admin verifies and clicks publish rather than typing.

- **M3.0:** Claude pre-fills, admin verifies every submission (trust building + accuracy validation)
- **M3.1:** Auto-publish when Claude confidence ≥ 85% (admin only sees ambiguous cases)

This inverts the workload: the admin goes from "data entry clerk" to "quality gate."

### 3. CLI admin tool, not a web UI

Building a web admin dashboard for a solo operator at MVP volume is premature. Start with a CLI: `npm run admin:submissions` lists pending work, `npm run admin:review <id>` opens a pre-filled form in the terminal. Ship a UI only if volume justifies it.

### 4. Supabase Storage for images

You already use Supabase for Postgres. Use Supabase Storage for images to keep one provider, one dashboard, one bill. RLS gives you per-user read scoping for free, and signed URLs avoid making the bucket public.

### 5. Light admin review, scales gracefully

Traditional crowdsourced catalogs fail when they require admin review of every submission. Our path:

- **M3.0:** Admin verifies all (needed for launch integrity)
- **M3.1:** Admin only touches low-confidence submissions (~15–30% of volume)
- **M3.2:** Community voting flags bad auto-publishes, admin audits weekly

---

## M3.0 — Submission endpoint + Claude pre-fill + CLI admin

### Prerequisites

Before writing a line of code, these gaps from the current codebase must be resolved:

1. **Admin auth.** There is no admin concept in [lib/auth.ts](../lib/auth.ts). Add an `ADMIN_USER_IDS` env var (comma-separated user IDs) and a `requireAdmin(request)` wrapper that returns 403 if the caller isn't on the list.
2. **`user_submissions.user_id` type mismatch.** The schema at [db/schema.ts:98](../db/schema.ts#L98) declares `user_id` as `uuid`, but `extractAuth` returns arbitrary strings like `'unverified'`. Change the column to `text` to match `scan_events.user_id`.
3. **Supabase Storage bucket.** Create a private bucket named `submissions` in the Supabase dashboard. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to env.
4. **`@supabase/supabase-js` package.** Needed for the storage client (we only use Drizzle for DB access, so this is just for Storage).
5. **`openai` package** + `OPENROUTER_API_KEY` env var. (OpenRouter exposes an OpenAI-compatible endpoint — no Anthropic SDK needed.)

### Storage: Supabase Buckets

**New file: `lib/storage/supabase.ts`**

```typescript
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client: ReturnType<typeof createClient> | null = null;

function getStorageClient() {
  if (!url || !serviceKey) {
    throw new Error('Supabase Storage not configured');
  }
  if (!client) {
    client = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export async function uploadSubmissionPhoto(
  submissionId: string,
  role: 'front' | 'back',
  file: Blob,
): Promise<string> {
  const path = `${submissionId}/${role}.jpg`;
  const { error } = await getStorageClient()
    .storage
    .from('submissions')
    .upload(path, file, {
      contentType: 'image/jpeg',
      upsert: true,
    });
  if (error) throw error;
  return path; // store the path, not the URL — sign on demand
}

export async function signedSubmissionUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { data, error } = await getStorageClient()
    .storage
    .from('submissions')
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw error ?? new Error('signed_url_failed');
  return data.signedUrl;
}
```

**Why store the path, not the URL:** signed URLs expire. Storing the stable path and generating a fresh signed URL when the admin opens the submission means URLs can't leak or go stale.

### Submission intake: `POST /api/products/submit`

**New file: `app/api/products/submit/route.ts`**

```typescript
import { after, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { products, userSubmissions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { uploadSubmissionPhoto } from '@/lib/storage/supabase';
import { extractSubmissionWithClaude } from '@/lib/ocr/claude-vision';
import { log } from '@/lib/logger';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  if (!auth.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const barcode = String(formData.get('barcode') ?? '');
  const front = formData.get('front');
  const back = formData.get('back');

  // Validation
  if (!barcode || !(front instanceof File) || !(back instanceof File)) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'barcode, front, back required' },
      { status: 400 },
    );
  }
  for (const file of [front, back]) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json({ error: 'unsupported_type' }, { status: 415 });
    }
  }

  const db = getDb();

  // Short-circuit: product already in catalog, no submission needed
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.barcode, barcode))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({
      status: 'already_in_catalog',
      product_id: existing[0].id,
      message: 'This product is already in our database.',
    });
  }

  // Create submission row first so we have the ID for the storage path
  const submissionId = randomUUID();
  const [submission] = await db
    .insert(userSubmissions)
    .values({
      id: submissionId,
      userId: auth.userId,
      barcode,
      photos: [],
      status: 'pending',
    })
    .returning();

  // Upload photos in parallel
  const [frontPath, backPath] = await Promise.all([
    uploadSubmissionPhoto(submissionId, 'front', front),
    uploadSubmissionPhoto(submissionId, 'back', back),
  ]);

  await db
    .update(userSubmissions)
    .set({
      photos: [
        { role: 'front', path: frontPath },
        { role: 'back', path: backPath },
      ],
    })
    .where(eq(userSubmissions.id, submissionId));

  log.info('submission_received', {
    submission_id: submissionId,
    barcode,
    user_id: auth.userId,
  });

  // OCR runs after response — never block the user upload
  after(async () => {
    try {
      const extracted = await extractSubmissionWithClaude({
        frontPath,
        backPath,
      });
      await db
        .update(userSubmissions)
        .set({
          ocrText: JSON.stringify(extracted),
        })
        .where(eq(userSubmissions.id, submissionId));
      log.info('submission_ocr_complete', {
        submission_id: submissionId,
        confidence: extracted.confidence,
      });
    } catch (err) {
      log.warn('submission_ocr_failed', {
        submission_id: submissionId,
        error: String(err),
      });
    }
  });

  return NextResponse.json(
    {
      submission_id: submissionId,
      status: 'pending_review',
      message: "Thank you! We'll review your submission within 24 hours.",
    },
    { status: 201 },
  );
}
```

**Key properties of this endpoint:**
- OCR is **non-blocking** (via `after()`) — user never waits for Claude
- Validates file size and MIME type before touching storage
- Short-circuits if the barcode is already in the catalog (cheap and prevents duplicate work)
- Stores Storage **paths**, not URLs — URLs are signed fresh when the admin views
- Persists OCR output as JSON in `ocr_text` for the CLI tool to render

### OCR: single-call extraction for both photos

**New file: `lib/ocr/claude-vision.ts`**

```typescript
import OpenAI from 'openai';
import { signedSubmissionUrl } from '@/lib/storage/supabase';

export type ExtractedSubmission = {
  name: string | null;
  brand: string | null;
  category: 'food' | 'grooming' | 'supplement' | null;
  ingredients: string[];
  confidence: number; // 0-100
  notes: string[];
};

const PROMPT = `You are extracting product metadata and ingredients from two photos of a consumer product.

Photo 1 is the FRONT of the product (brand, name, category clues).
Photo 2 is the BACK of the product (ingredients panel).

Return STRICT JSON with this shape, nothing else:
{
  "name": string | null,
  "brand": string | null,
  "category": "food" | "grooming" | "supplement" | null,
  "ingredients": string[],   // in order as listed, no percentages, no allergen callouts, no directives
  "confidence": number,      // 0-100, your overall confidence in the extraction
  "notes": string[]          // any concerns (blurry, partial, handwritten, etc.)
}

Rules:
1. "category" must be one of the three enum values or null. If unsure, pick the closest and lower confidence.
2. "ingredients" must be in label order. Strip "Water (60%)" → "Water". Strip "Contains: peanuts" lines.
3. Return confidence = 0 if you cannot read either photo.
4. Return confidence < 50 if the back photo is unreadable OR the front is missing branding.
5. Output raw JSON, no markdown fences, no commentary.`;

export async function extractSubmissionWithClaude(opts: {
  frontPath: string;
  backPath: string;
}): Promise<ExtractedSubmission> {
  const [frontUrl, backUrl] = await Promise.all([
    signedSubmissionUrl(opts.frontPath, 600),
    signedSubmissionUrl(opts.backPath, 600),
  ]);

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const response = await client.chat.completions.create({
    model: 'anthropic/claude-opus-4-6',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: frontUrl } },
          { type: 'image_url', image_url: { url: backUrl } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error('unexpected_response_type');
  return JSON.parse(content) as ExtractedSubmission;
}
```

**Why a single call for both photos:** cheaper (one round-trip), and Claude can cross-reference the front and back (e.g., confirm brand consistency, flag mismatches). Cost is ~$0.15–0.25 per submission at current pricing.

**Model choice:** start with `claude-opus-4-6` for accuracy. If cost becomes an issue at scale, drop to `claude-sonnet-4-6`.

### CLI admin tool

**New file: `scripts/admin-submissions.ts`**

```typescript
// Usage:
//   npm run admin:submissions                    # list pending
//   npm run admin:review <submission_id>         # open interactive review
//   npm run admin:reject <submission_id> <reason>

import { asc, eq } from 'drizzle-orm';
import { createInterface } from 'node:readline/promises';

import { getDb } from '@/db/client';
import { userSubmissions, products, productIngredients } from '@/db/schema';
import { signedSubmissionUrl } from '@/lib/storage/supabase';
import { scoreProduct } from '@/lib/scoring';

async function listPending() {
  const db = getDb();
  const rows = await db
    .select()
    .from(userSubmissions)
    .where(eq(userSubmissions.status, 'pending'))
    .orderBy(asc(userSubmissions.createdAt));

  console.log(`\n${rows.length} pending submissions:\n`);
  for (const row of rows) {
    console.log(
      `  ${row.id}  ${row.barcode}  ${row.createdAt.toISOString()}`,
    );
  }
}

async function reviewOne(submissionId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userSubmissions)
    .where(eq(userSubmissions.id, submissionId))
    .limit(1);

  if (!row) {
    console.error('Not found');
    process.exit(1);
  }

  const photos = row.photos as Array<{ role: string; path: string }>;
  const frontUrl = await signedSubmissionUrl(
    photos.find((p) => p.role === 'front')!.path,
  );
  const backUrl = await signedSubmissionUrl(
    photos.find((p) => p.role === 'back')!.path,
  );

  const ocr = row.ocrText ? JSON.parse(row.ocrText) : null;

  console.log('\n─── Submission ─────────────────────────────');
  console.log(`ID:       ${row.id}`);
  console.log(`Barcode:  ${row.barcode}`);
  console.log(`Front:    ${frontUrl}`);
  console.log(`Back:     ${backUrl}`);
  console.log('\n─── Claude pre-fill ───────────────────────');
  if (!ocr) {
    console.log('(OCR not yet complete — retry in a moment)');
    return;
  }
  console.log(`Confidence: ${ocr.confidence}`);
  console.log(`Name:       ${ocr.name ?? '(none)'}`);
  console.log(`Brand:      ${ocr.brand ?? '(none)'}`);
  console.log(`Category:   ${ocr.category ?? '(none)'}`);
  console.log(`Ingredients (${ocr.ingredients.length}):`);
  ocr.ingredients.forEach((ing: string, i: number) =>
    console.log(`  ${i + 1}. ${ing}`),
  );
  if (ocr.notes.length) console.log(`Notes: ${ocr.notes.join('; ')}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await rl.question(`\nName [${ocr.name ?? ''}]: `)) || ocr.name;
  const brand =
    (await rl.question(`Brand [${ocr.brand ?? ''}]: `)) || ocr.brand;
  const category =
    (await rl.question(`Category [${ocr.category ?? ''}]: `)) || ocr.category;
  const ingredientsInput = await rl.question(
    `Ingredients (comma-separated, blank to keep): `,
  );
  const ingredients = ingredientsInput
    ? ingredientsInput.split(',').map((s) => s.trim()).filter(Boolean)
    : ocr.ingredients;

  const confirm = await rl.question(`\nPublish? (y/N): `);
  rl.close();
  if (confirm.toLowerCase() !== 'y') {
    console.log('Aborted');
    return;
  }

  // Publish: upsert product + ingredients + score, mark submission published
  // (Implementation reuses lib/cron/ingest-helpers.ts upsertProduct with source='user')
  // ...

  console.log('\n✓ Published');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'list' || !cmd) await listPending();
else if (cmd === 'review' && arg) await reviewOne(arg);
else {
  console.log('Usage: admin-submissions [list|review <id>]');
  process.exit(1);
}
```

**Why a CLI is the right choice for M3.0:**
- Zero UI code — ship the feature in hours, not days
- Admin workflow is a linear checklist, which CLI handles perfectly
- You can view both photos in the browser by clicking the signed URLs
- When/if volume justifies a web UI, the CLI logic moves into API routes with minimal refactoring

**Extend `upsertProduct` to accept `source: 'user'`** in [lib/cron/ingest-helpers.ts](../lib/cron/ingest-helpers.ts#L21). Currently the type restricts to `'off' | 'obf' | 'dsld'` — change to include `'user'` and add a `sourceId: submissionId` parameter.

### Schema adjustments

The existing `user_submissions` table at [db/schema.ts:96](../db/schema.ts#L96) is mostly fine but needs two tweaks:

1. **Change `user_id` from `uuid` to `text`** to match `scan_events.user_id` and the current auth return type
2. **Add a `reviewed_by` text column** (null = auto-published or unreviewed; set to admin ID on manual publish) — avoids polluting the status enum with `auto_published`

No enum change needed — the existing `['pending', 'in_review', 'published', 'rejected']` is sufficient.

```sql
ALTER TABLE user_submissions
  ALTER COLUMN user_id TYPE text,
  ADD COLUMN IF NOT EXISTS reviewed_by text;
```

### Verification checklist (M3.0)

- [ ] `ADMIN_USER_IDS` env + `requireAdmin` wrapper in [lib/auth.ts](../lib/auth.ts)
- [ ] Supabase `submissions` bucket created (private)
- [ ] `POST /api/products/submit` accepts valid uploads, rejects oversized/wrong-MIME files
- [ ] Endpoint short-circuits if barcode already exists in `products`
- [ ] Photos land in Supabase Storage at `{submission_id}/{front|back}.jpg`
- [ ] `after()` job populates `ocr_text` with Claude's JSON extraction
- [ ] `npm run admin:submissions` lists pending submissions
- [ ] `npm run admin:review <id>` displays signed URLs + pre-filled form
- [ ] Publishing creates a `products` row with `source='user'` and full ingredient rows
- [ ] Next scan of that barcode returns the published product (no 404)

---

## M3.1 — Auto-publish at high confidence

**Status:** ✅ Shipped. Auto-publish runs inline inside `POST /api/products/submit` immediately after Claude Vision finishes.

### Goal

Skip the admin queue entirely for submissions Claude is confident about, while keeping the existing CLI tool as a fallback for the remaining edge cases. The operator should never touch a submission that was clearly photographed and correctly extracted.

### What shipped

1. **New shared module:** [`lib/submissions/auto-publish.ts`](../../lib/submissions/auto-publish.ts) exports two functions backed by a single private `buildAndPublish` helper:
   - `tryAutoPublish({ submissionId, barcode, extracted })` — gated by guardrails + confidence, never throws, returns a discriminated `AutoPublishResult`.
   - `publishExtracted({ submissionId, barcode, name, brand, category, ingredients, reviewedBy })` — unconditional publish for the CLI, throws on failure so the operator sees the error and the CLI rolls the submission back to `pending`.
2. **Inline call from the submit route:** [`app/api/products/submit/route.ts`](../../app/api/products/submit/route.ts) calls `tryAutoPublish` immediately after the OCR try/catch, using the in-scope `extracted` value. A new `submission_auto_publish_outcome` log line records the result for every submission.
3. **CLI refactor:** [`scripts/admin-submissions.ts`](../../scripts/admin-submissions.ts) `reviewOne()` no longer contains its own publish path — it calls `publishExtracted` with operator-supplied values. Preview of dictionary-resolved flags still prints before the `Publish? (y/N)` prompt so the operator can bail.
4. **Type contract:** `SubmissionResponse` in [`types/guardscan.ts`](../../types/guardscan.ts) now carries a third variant, `auto_published`, returned when the inline publish succeeds. The existing `pending_review` and `already_in_catalog` variants are unchanged.

No schema migration was required. Every column the flow depends on (`products.source='user'`, `user_submissions.reviewed_by`, `user_submissions.status='published'`) was already present from M3.0.

### Confidence gate

Auto-publish requires `extracted.confidence >= AUTO_PUBLISH_CONFIDENCE_THRESHOLD` (currently **85**, defined at the top of `lib/submissions/auto-publish.ts` for easy tuning).

Rationale:
- Below 85: Claude has expressed doubt (blurry photo, partial list, ambiguous category). The CLI operator should see these.
- 85–95: Claude is confident and almost always right. Auto-publishing is low-risk.
- 95+: essentially always correct.

Revisit the threshold after ~50 real submissions have flowed through. If spot-check accuracy at 85 is >98%, consider dropping to 80. If it's <95%, raise to 90.

### Guardrails (hard rejects, regardless of confidence)

`tryAutoPublish` bails out before touching the products table if any of the following are true:

| Check | `reason` | Rationale |
|---|---|---|
| `extracted.name` is null | `guardrail_name` | No catalog display |
| `extracted.category` is null | `guardrail_category` | Can't route to the correct scoring logic |
| `extracted.ingredients.length < 2` | `guardrail_ingredients` | Probably a failed OCR pass |

We intentionally do **not** implement the "duplicate barcode in the last 60 seconds" guardrail that an earlier draft of this doc proposed — the existing `products.barcode` UNIQUE constraint plus `onConflictDoUpdate` in `upsertProduct` already handle the race cleanly (latest write wins).

### Failure handling

Failed guardrails, low confidence, and upsert errors all leave the submission row as `status='pending'`. This preserves the CLI admin tool as a fallback: `npm run admin:submissions list` will still surface these rows, and the operator can review them manually whenever they want.

The user-facing HTTP response never fails because of an auto-publish error — the photos and OCR are already durable. The client sees `pending_review` in the failure case (identical to M3.0 behavior) or the new `auto_published` variant on success.

### `reviewed_by` semantics

| `status` | `reviewed_by` | Meaning |
|---|---|---|
| `published` | `NULL` | Auto-published by M3.1 |
| `published` | `'cli'` or an admin user ID | Manually published via the CLI |
| `pending` | `NULL` | Unreviewed |

Audit query for auto-published rows:
```sql
SELECT id, barcode, created_at
FROM user_submissions
WHERE status = 'published' AND reviewed_by IS NULL
ORDER BY created_at DESC;
```

### Verification checklist (M3.1)

- [ ] `confidence < 85` leaves the submission `pending` with outcome `low_confidence` in logs
- [ ] `name = null` → `guardrail_name`, submission stays `pending`
- [ ] `category = null` → `guardrail_category`, submission stays `pending`
- [ ] `ingredients.length < 2` → `guardrail_ingredients`, submission stays `pending`
- [ ] Happy path: confidence ≥ 85 + all fields valid → `products` row exists with `source='user'`, `source_id=submissionId`, score populated, and `user_submissions.status='published'` with `reviewed_by IS NULL`
- [ ] Re-scanning the barcode immediately after auto-publish hits the DB cache (no 404, no second submission)
- [ ] OCR failure path: submit still returns `pending_review`, no auto-publish is attempted, `submission_ocr_failed` log fires
- [ ] Upsert failure path: `tryAutoPublish` returns `{ kind: 'failed' }`, logs `auto_publish_failed`, submission stays `pending`
- [ ] CLI `npm run admin:submissions review <id>` still works end-to-end and sets `reviewed_by = 'cli'` (or the admin user ID)
- [ ] `submission_auto_publish_outcome` log line appears exactly once per submission and contains the correct discriminator fields

### What was intentionally deferred

- **`npm run admin:audit` / `npm run admin:unpublish`.** These were planned here but aren't needed until auto-publish volume grows enough to warrant spot-checking. Add when the CLI queue has been mostly empty for several weeks and you want to sanity-check what went through without review.
- **Expo "Added instantly!" celebration UX.** The backend ships the `auto_published` response variant; the Expo app at `app/submit-product.tsx` currently treats every success response identically. A client-side follow-up can branch on `status === 'auto_published'` to surface a celebratory message. See [cucumberdude/docs/product/SUBMISSION-FLOW-IMPL.md](../../../cucumberdude/docs/product/SUBMISSION-FLOW-IMPL.md).
- **Migrating the inline OCR + publish work to `after()`.** The submit route's own comment explains why: `after()` silently no-ops on the current Vercel deployment because `waitUntil` isn't provided. Investigating that is a separate cleanup, not a blocker — `maxDuration=60` gives us comfortable headroom for the inline Claude call plus the ~100–500 ms upsert.

---

## M3.2 — Polish: on-device product detection + auto-crop

**Timeline:** After M3.1 has been running long enough to establish a baseline auto-publish rate (~4 weeks of data).
**Goal:** Match the competitor capture UX where a visible bounding box identifies the product in frame, and **use that boundary to auto-crop the photo before upload.** Better ergonomics for the user, tighter input for Claude, higher extraction accuracy.

### What this phase is NOT

Not product recognition. We are not identifying *which* product is in the frame — barcode + OCR still do that. We are identifying *where in the frame* the product is, so we can crop to it. This is localization, not recognition.

### Why auto-cropping improves extraction

Claude Opus 4.6 is excellent at focusing on relevant content, but its accuracy degrades when the product is a small portion of the frame surrounded by distractors (hands, background, packaging glare, adjacent products on a shelf). A tight, padded crop:

- Reduces input tokens per extraction (lower cost at scale)
- Removes visual distractors that compete for Claude's attention
- Concentrates the model's budget on the label text
- Produces more consistent confidence scores (the single signal we use to gate auto-publish)

Expected lift: **+5–10% auto-publish rate** vs. the uncropped M3.1 baseline. Combined with the ≥85% confidence gate, this should push the fully-automated share above 85% of all submissions.

### Technical approach: two paths

Ship Path A first. Path B is the final polish if volume justifies the engineering.

#### Path A — Post-capture crop (simpler, ship first)

1. User captures a photo via `expo-image-picker` as today
2. Immediately after capture, run on-device object detection on the still image to find the dominant rectangular object
3. If detected with high confidence, crop the photo to that bounding box plus ~10% padding
4. Show the cropped result in the review step with a "looks good / retake" prompt
5. If detection fails or confidence is low, fall back silently to the uncropped photo

On-device detection options:
- **iOS:** Apple Vision `VNDetectRectanglesRequest` (built-in, zero dependencies, excellent for boxed/bottled products) or `VNGenerateObjectnessBasedSaliencyImageRequest` (iOS 13+, finds salient objects)
- **Android:** ML Kit Object Detection & Tracking API in "prominent object" mode (built-in, detects the largest foreground object)
- **Cross-platform wrapper:** `expo-camera` + a native module that calls the platform APIs, or `react-native-vision-camera` with frame processors

Neither platform needs a custom trained model — the built-in object detection is designed exactly for this "find the thing in the middle of the frame" use case.

#### Path B — Real-time bounding box + auto-capture (polished, ship after A)

The competitor experience: yellow box tracks the product live, auto-captures when stable.

1. Replace `expo-image-picker` with `expo-camera` (`CameraView`) or `react-native-vision-camera`
2. Attach a frame processor running object detection at 10–30 fps on downsampled frames
3. Render a yellow bounding box overlay on the live preview whenever detection fires
4. When the box is stable (low jitter) for 500ms and well-framed (occupies 40–80% of frame), auto-capture
5. Crop to the last stable box + padding, run OCR, upload

Path B is ~2–3x the engineering effort of Path A and requires moving off `expo-image-picker`. Worth it for a marquee UX moment, not worth it until the submission flow is otherwise proven.

### Implementation notes

- **Cropping happens client-side.** The cropped image is what gets uploaded to `/api/products/submit`. Backend is unchanged — it still receives a front photo and a back photo, just tighter ones.
- **Keep the uncropped original** in a hidden field only on-device, in case the user retakes. Don't upload both.
- **Graceful degradation:** if the detection fails, the user never sees a failure — they get the old UX (uncropped photo). Detection is a silent upgrade, never a gate.
- **Don't over-crop.** 10% padding on each side is the floor. Label text at the edges of a product must stay in frame.
- **Separate detection for front vs. back.** Front photos often include the product in perspective; back photos are usually flatter. You may want slightly different detection parameters per role (e.g., prefer larger bounding boxes on the back to ensure the full ingredient panel is captured).

### Why this is the only vision work worth doing

There's exactly one vision problem between us and a zero-admin pipeline: **the user gives us photos with too much noise in the frame.** Auto-cropping fixes it at the source using tech that already ships with iOS and Android. No hosted models, no extra API calls, no new failure modes on the server.

Everything else in the extraction pipeline stays the same: **one Claude Opus 4.6 call, two photos, one JSON response.** We do not need multi-model ensembles, segmentation services, or custom vision infrastructure. We need cleaner inputs, and the OS vendors give us that for free.

### Verification checklist (M3.2)

- [ ] On-device object detection runs on both iOS and Android without adding server cost
- [ ] Captured photos are cropped to the detected bounding box + ~10% padding before upload
- [ ] Graceful fallback: detection failure uploads the uncropped photo silently
- [ ] (Path B only) Yellow bounding box overlay is visible in live preview and tracks the product
- [ ] (Path B only) Auto-capture fires when the box is stable for 500ms
- [ ] Auto-publish rate increases by ≥5% vs. the M3.1 baseline (measured over 2+ weeks)
- [ ] Average Claude input token count per submission decreases (cost proxy)

---

## Future work (not in this doc)

- **Crowdsourced QC.** Once auto-publish volume exceeds what admin spot-checks can cover (~200+/week), add user-facing "report this product" voting. Disputed products (3+ reports) auto-unpublish pending review. Write a dedicated doc when the time comes.
- **Custom admin web UI.** Replace the CLI with a browser interface once volume justifies it (likely never for a solo operator at MVP scale).

---

## Admin workload projection

| Volume / week | Without OCR pre-fill | With M3.0 pre-fill | With M3.1 auto-publish (shipped) |
|---|---|---|---|
| 10 | 20–50 min | 5–10 min | 0–5 min |
| 50 | 2–4 hours | 25–40 min | 10–15 min |
| 100 | 4–8 hours | 50–80 min | 20–30 min |
| 300 | 15+ hours (untenable) | 2.5–4 hours | 1–1.5 hours |

**Post-M3.1:** the CLI is the fallback path, not the primary path. Any submission the operator sees is one Claude was explicitly unsure about, missing a required field, or failed to publish for infrastructure reasons. Expected fallback volume is 10–30% of total submissions, scaling down as photography conditions improve (M3.2 on-device cropping).

**Realistic early volume:** 0–5 submissions/week in month 1, 20–50/week by month 3 if users find value. With auto-publish running, the operator's weekly CLI time should stay under 30 minutes even at 100 submissions/week.

---

## Files touched

### M3.0

| Action | File | What |
|---|---|---|
| New | `app/api/products/submit/route.ts` | Submission endpoint |
| New | `lib/storage/supabase.ts` | Supabase Storage client + signed URLs |
| New | `lib/ocr/claude-vision.ts` | Single-call OCR extraction |
| New | `scripts/admin-submissions.ts` | CLI admin tool |
| New | `drizzle/00XX_user_submissions_tweaks.sql` | user_id→text, add reviewed_by |
| Modify | `lib/auth.ts` | Add `requireAdmin` |
| Modify | `lib/cron/ingest-helpers.ts` | Accept `source: 'user'` in upsertProduct |
| Modify | `package.json` | Add `admin:submissions` / `admin:review` scripts |
| Modify | `.env.example` | Document new env vars |

### M3.1

| Action | File | What |
|---|---|---|
| New | `lib/submissions/auto-publish.ts` | `tryAutoPublish` (gated) + `publishExtracted` (CLI) sharing one `buildAndPublish` path |
| Modify | `app/api/products/submit/route.ts` | Call `tryAutoPublish` inline after OCR; branch the response between `auto_published` and `pending_review` |
| Modify | `types/guardscan.ts` | Add `SubmissionResponse` discriminated union with the `auto_published` variant |
| Modify | `scripts/admin-submissions.ts` | Replace inline publish with a call to `publishExtracted`; keep the ingredient preview for operator context |
| Modify | `docs/milestones/m3-user-submissions.md` | This doc — promote M3.1 from plan to shipped |

### M3.2 (Expo repo)

Backend is unchanged in M3.2 — cropping is entirely client-side. Expo changes live in [cucumberdude/docs/product/USER-SUBMISSIONS-UX.md](../../cucumberdude/docs/product/USER-SUBMISSIONS-UX.md) and will include:

| Action | File | What |
|---|---|---|
| New (Path A) | `lib/vision/detect-product.ts` | On-device object detection wrapper (Apple Vision / ML Kit) |
| Modify (Path A) | `app/(tabs)/scan/(submission)/submit-product.tsx` | Post-capture crop step before upload |
| New (Path B) | `components/scan/ProductCaptureView.tsx` | Live camera view with bounding box overlay |
| Modify (Path B) | `app/(tabs)/scan/(submission)/submit-product.tsx` | Replace image picker with live capture view |

---

## Environment variables added

```
SUPABASE_URL                 # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY    # Service-role key (server-only, never ship to client)
OPENROUTER_API_KEY           # OpenRouter API key for OCR (routes to Claude via OpenAI-compatible endpoint)
ADMIN_USER_IDS               # Comma-separated user IDs with admin rights
```

---

## Open questions

1. **Category scoring for unknowns.** If Claude returns a category the scoring engine doesn't handle (e.g., supplement before M2 DSLD integration), what do we do? Proposed: publish with score `null` and a placeholder `data_completeness: 'partial'` so the product appears in scan results but without a score.
2. **Photo retention.** Do we keep submission photos forever? Proposed: retain indefinitely for auto-publish disputes, but add a CLI command to purge photos older than N days for rejected submissions.
3. **Locale / language.** Claude handles non-English labels well, but the dictionary is English-only. Non-English submissions will publish with `flag: neutral` for every ingredient. Acceptable for M3, flag for M4+.
