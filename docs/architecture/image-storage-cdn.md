# Image Storage & CDN — Performance Fix Proposal

**Status:** Proposed
**Affects:** `lib/storage/supabase.ts` + 6 API route files
**No DB migration required.**

---

## Problem

User-submitted product images load slowly. Two compounding causes:

### 1. Signed URLs bypass CDN caching

`resolveImageUrl()` currently generates a Supabase signed URL (48-hour TTL) for every storage-path `image_front` value. Signed URLs look like:

```
https://{project}.supabase.co/storage/v1/object/sign/submissions/{path}?token=eyJ...
```

The unique `?token=` query string makes every URL distinct. CDNs can't cache responses keyed to a unique token, so every `<Image>` render in the mobile app hits Supabase's origin server — regardless of how recently another user loaded the same image.

### 2. Extra SDK roundtrip on every API response

`resolveImageUrl()` is `async` and calls `supabase.storage.createSignedUrl()` over the network. This happens for every product returned by an API route. The history route (up to 50 products per page) runs `Promise.all` over 50 such calls before it can respond.

---

## Root Cause Verification

These are the confirmed facts the fix is based on:

| Assumption | Evidence |
|---|---|
| `image_front` for OBF/OFF products is an absolute HTTPS URL | Records 250 in sample data: `https://images.openbeautyfacts.org/...` |
| `image_front` for user-submitted products is a relative Supabase Storage path | Records 251, 446, 447 in sample data: `{uuid}/front.jpg` |
| The storage path format is `{submissionId}/{role}.jpg` | `lib/storage/supabase.ts:26`: `const path = \`${submissionId}/${role}.jpg\`` |
| Supabase Storage serves public objects through Cloudflare CDN globally | Supabase architecture; all plans including free. CDN only activates for public objects. |
| Product front images contain no sensitive or personal data | They are photos of product packaging submitted to enrich the public catalog. |
| All `image_front` paths in the DB are paths in the `submissions` bucket | Confirmed: `source_id` matches UUID prefix in `image_front` for all user records |

---

## Proposed Solution

**Make the `submissions` bucket public and replace signed URLs with deterministic public CDN URLs.**

A public Supabase Storage URL is:
```
https://{project}.supabase.co/storage/v1/object/public/submissions/{path}
```

This URL is:
- **Deterministic** — the same image always has the same URL.
- **CDN-cached** — Supabase serves public objects via Cloudflare's global edge network (150+ locations).
- **Constructed in memory** — no SDK call, no network roundtrip.
- **Backward-compatible** — existing `image_front` paths in the DB are already in the right format.

### What this does NOT require

- No DB schema change.
- No data migration — the relative paths already stored (e.g. `aef6e6eb-a666-4c1b-8d9f-e36f663b7640/front.jpg`) work as-is with the new URL format.
- No change to the mobile app — `image_url` is still a string on the `Product` type.
- No new services, dependencies, or infrastructure costs.

---

## Exact Changes

### Step 1 — Supabase Dashboard (manual, one-time)

1. Open your Supabase project → **Storage** → **`submissions`** bucket.
2. Click **Edit bucket** → toggle **Public bucket** → **Save**.

This activates CDN caching for all objects in the bucket. Existing uploads are immediately accessible via public URL with no further action.

---

### Step 2 — `lib/storage/supabase.ts`

**`resolveImageUrl`** — change from `async` (SDK call) to `sync` (string construction):

```ts
// BEFORE
export async function resolveImageUrl(
  imageFront: string | null,
): Promise<string | null> {
  if (!imageFront) return null;
  if (imageFront.startsWith('http')) return imageFront;
  try {
    return await signedSubmissionUrl(imageFront, 172_800); // 48h
  } catch {
    return null;
  }
}
```

```ts
// AFTER
export function resolveImageUrl(imageFront: string | null): string | null {
  if (!imageFront) return null;
  if (imageFront.startsWith('http')) return imageFront;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;
  return `${supabaseUrl}/storage/v1/object/public/submissions/${imageFront}`;
}
```

**`uploadSubmissionPhoto`** — add a long-lived `Cache-Control` header so Cloudflare caches images aggressively. Product photos are immutable once uploaded — they never change.

> **Critical:** This change is equally important to flipping the bucket. Without it, Supabase may emit a default `Cache-Control` that prevents Cloudflare from caching at all, even for public objects. Making the bucket public without this header only fixes *access* — not *speed*.

```ts
// BEFORE
.upload(path, file, {
  contentType: 'image/jpeg',
  upsert: true,
});

// AFTER
.upload(path, file, {
  contentType: 'image/jpeg',
  upsert: true,
  cacheControl: '31536000', // 1 year — immutable product photos
});
```

`signedSubmissionUrl` becomes unused. Remove it.

#### Existing uploads

The `cacheControl` change only applies to **new** uploads. Objects already in the bucket were stored without this header and will carry whatever `Cache-Control` Supabase assigned at upload time (often `max-age=0` or no-cache). To apply the long-lived header retroactively, re-upload each existing file using the Supabase Storage API with the new metadata, or use `supabase.storage.updateFileMetadata()` if your project's SDK version supports it.

At current scale (a handful of submissions) this can be done manually. If deferred, existing images will still load correctly — just without aggressive CDN caching until they are re-uploaded.

---

### Step 3 — API routes: remove `await` and clean up `async` map

`resolveImageUrl` is now synchronous. All 8 call sites currently `await` it. JavaScript handles `await syncValue` silently (it just returns the value), so these still compile and run correctly without changes. However, cleaning them up removes misleading `async` markers and, for the history route, removes the unnecessary `Promise.all` wrapper.

#### `app/api/products/scan/[barcode]/route.ts` — 2 locations

**Line 90** (inside `fetchInlineAlternatives`):
```ts
// BEFORE
image_url: await resolveImageUrl(row.imageFront),

// AFTER
image_url: resolveImageUrl(row.imageFront),
```

**Line 161** (DB cache path, inside GET handler):
```ts
// BEFORE
image_url: await resolveImageUrl(row.imageFront),

// AFTER
image_url: resolveImageUrl(row.imageFront),
```

#### `app/api/products/[id]/route.ts` — line 93

```ts
// BEFORE
image_url: await resolveImageUrl(row.imageFront),

// AFTER
image_url: resolveImageUrl(row.imageFront),
```

#### `app/api/products/search/route.ts` — line 156

The outer `Promise.all(rows.map(async (row) => ...))` pattern was introduced to support `await resolveImageUrl`. With a synchronous resolver, remove the `async` and the `Promise.all` wrapper.

```ts
// BEFORE
image_url: await resolveImageUrl(row.imageFront),

// AFTER
image_url: resolveImageUrl(row.imageFront),
```

#### `app/api/products/[id]/alternatives/route.ts` — line 100

```ts
// BEFORE
image_url: await resolveImageUrl(row.imageFront),

// AFTER
image_url: resolveImageUrl(row.imageFront),
```

#### `app/api/recommendations/route.ts` — lines 158 and 180

```ts
// BEFORE (line 158)
image_url: await resolveImageUrl((r.image_front as string) ?? null),

// AFTER
image_url: resolveImageUrl((r.image_front as string) ?? null),
```

```ts
// BEFORE (line 180)
image_url: await resolveImageUrl((r.alt_image_front as string) ?? null),

// AFTER
image_url: resolveImageUrl((r.alt_image_front as string) ?? null),
```

#### `app/api/profiles/me/history/route.ts` — line 78

This route was changed from `.map()` to `await Promise.all(map(async ...))` when `resolveImageUrl` was async. With a synchronous resolver it can be reverted:

```ts
// BEFORE
const data: ScanHistoryItem[] = await Promise.all((rows as Record<string, unknown>[]).map(async (row) => {
  const scoreVal = (row.score as number | null) ?? null;
  const rating = scoreVal != null ? getRating(scoreVal).label : null;
  const product: Product = {
    // ... all product fields unchanged ...
    image_url: await resolveImageUrl((row.image_front as string) ?? null),
    // ... remaining fields unchanged ...
  };
  return { /* ScanHistoryItem fields */ };
}));

// AFTER — remove async, remove Promise.all
const data: ScanHistoryItem[] = (rows as Record<string, unknown>[]).map((row) => {
  const scoreVal = (row.score as number | null) ?? null;
  const rating = scoreVal != null ? getRating(scoreVal).label : null;
  const product: Product = {
    // ... all product fields unchanged ...
    image_url: resolveImageUrl((row.image_front as string) ?? null),
    // ... remaining fields unchanged ...
  };
  return { /* ScanHistoryItem fields */ };
});
```

---

## Execution Order

1. **Flip bucket to public** in Supabase dashboard (reversible in 10 seconds if needed).
2. **Apply code changes** — `lib/storage/supabase.ts` first, then routes.
3. **`npm run build`** — verify TypeScript is clean.
4. **Deploy to a Vercel preview** (`vercel deploy`). Run [Fast Load Verification](#fast-load-verification) against the preview URL.
5. **Promote to production** (`vercel deploy --prod`).
6. **Verify CDN caching is active** against the production URL.

**Rollback:** If production behaves unexpectedly, run `vercel rollback` to revert the function code instantly. Then flip the bucket back to private in the Supabase dashboard. Both steps are independent and take under a minute each.

---

## Fast Load Verification

After deploying, run these checks to confirm CDN caching is working — not just that images are accessible.

### 1. Confirm the API returns a public URL

Use a barcode from a user-submitted product (i.e. one where `source = 'user'` in the DB — query below):

```sql
SELECT barcode FROM products WHERE source = 'user' AND image_front IS NOT NULL LIMIT 1;
```

```bash
curl -s "https://{your-api}/api/products/scan/{barcode}" | jq '.image_url'
```

**Pass:** URL matches `https://{project}.supabase.co/storage/v1/object/public/submissions/...` with no `?token=` parameter.
**Fail:** URL contains `/object/sign/` or `?token=` — the code change wasn't deployed.

> **Note:** OFF/OBF products (`source = 'off'` or `'obf'`) will always return an absolute external URL regardless of this change — they are not a valid test case.

### 2. Confirm Cloudflare is caching the image

Fetch the image URL twice and check the `CF-Cache-Status` response header. The second request must hit the cache, not the origin.

```bash
IMAGE_URL="https://{project}.supabase.co/storage/v1/object/public/submissions/{path}"

# First request — populates the cache (expect MISS or DYNAMIC)
curl -sI "$IMAGE_URL" | grep -i 'cf-cache-status\|cache-control\|content-length'

# Second request — must be served from cache
curl -sI "$IMAGE_URL" | grep -i 'cf-cache-status\|cache-control\|content-length'
```

**Pass:** Second request shows `CF-Cache-Status: HIT`.
**Fail outcomes and causes:**

| `CF-Cache-Status` | Meaning | Fix |
|---|---|---|
| `MISS` on second request | Cloudflare fetched origin twice — caching not active | Check `Cache-Control` header on the response; likely the `cacheControl: '31536000'` upload option was not applied |
| `BYPASS` | Cloudflare deliberately skipped cache | Supabase or Cloudflare config is overriding — contact Supabase support |
| `DYNAMIC` | Response is not eligible for caching | Same root cause as `MISS`; `Cache-Control` header is missing or set to `no-store` / `max-age=0` |

### 3. Confirm the `Cache-Control` header is correct

```bash
curl -sI "$IMAGE_URL" | grep -i cache-control
```

**Pass:** `cache-control: public, max-age=31536000`
**Fail:** `cache-control: no-cache` or `max-age=0` — the object was uploaded before the `cacheControl` fix and needs to be re-uploaded (see [Existing uploads](#existing-uploads)).

### 4. Measure latency from a cold edge

Use a free global HTTP tester (e.g. [httpstatus.io](https://httpstatus.io) or `curl` from a VPS in a different region) and request the image URL. A cache hit from a warm Cloudflare PoP should respond in **< 50 ms** for most regions. Origin latency (cache miss) will typically be 200–500 ms from a distant region.

> **Note on regional coverage:** Cloudflare's PoP network is dense in North America, Europe, and East Asia. First-load latency (cache miss) may still be 200–500 ms for users in Southeast Asia, Sub-Saharan Africa, or South America if the nearest PoP is far from Supabase's origin. This is a Cloudflare infrastructure constraint — not something this fix can address. Repeat loads (cache hits) will be fast everywhere.

---

## Migration of Existing Records

No URL migration required. All `image_front` values currently stored in the DB are relative paths (e.g. `aef6e6eb-a666-4c1b-8d9f-e36f663b7640/front.jpg`). These are the exact path segments that go into the public URL. Making the bucket public is sufficient.

To confirm all user-submitted images exist in storage before flipping the bucket (optional sanity check):

```sql
SELECT id, barcode, name, image_front
FROM products
WHERE source = 'user'
  AND image_front IS NOT NULL
ORDER BY created_at;
```

Cross-reference the returned paths against Supabase Storage → `submissions` bucket. Any missing files represent submissions where the upload failed — those products will render the initials placeholder as before.

---

## Cost

| Plan | Storage | Egress | CDN |
|---|---|---|---|
| Free | 1 GB | Included | Cloudflare global |
| Pro ($25/mo) | 100 GB | Included | Cloudflare global |

At current scale (a handful of user-submitted products, ~200–500 KB each), total storage is under 10 MB — well within the free tier. OBF/OFF images are served from their own CDN and are unaffected.

---

## Trade-offs

| Concern | Assessment |
|---|---|
| Privacy of product photos | Not a concern. These are photos of retail product packaging submitted to enrich a public catalog. No personal data. |
| URL stability | Public URLs are permanent and deterministic. Signed URLs expired after 48h — the new approach is strictly more stable. |
| Someone scraping the storage bucket | Risk is negligible. Images are product packaging photos with no commercial or personal value to a scraper. |
| `SUPABASE_URL` must be set | Already required for storage uploads (`lib/storage/supabase.ts`). Not a new dependency. |
| Existing uploads may not have long-lived cache headers | Objects uploaded before this change may show `CF-Cache-Status: MISS` until re-uploaded. See [Existing uploads](#existing-uploads). |

---

## What This Does Not Fix

OBF/OFF product images (absolute `https://images.openbeautyfacts.org/...` URLs) are served by the Open Beauty/Food Facts CDN. Their load speed is outside our control. The fix above only affects user-submitted images.
