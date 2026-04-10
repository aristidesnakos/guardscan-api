# Test: User Submission Flow (Production)

End-to-end manual test of `POST /api/products/submit` against the live Vercel deployment. Validates the M3.0/M3.1 pipeline: upload → Supabase Storage → `user_submissions` row → Claude Vision OCR (background) → admin CLI review → publish to `products`.

Use this when you need to confirm the production submission pipeline is healthy without waiting for an Expo client build, or when triaging a "product not recognized" 404 on an unknown barcode.

---

## Prerequisites

| Requirement | How to verify |
|---|---|
| Project linked to Vercel | `vercel whoami` returns your account |
| `DATABASE_URL` set on Production | `vercel env ls production \| grep DATABASE_URL` |
| `SUPABASE_JWT_SECRET` set on Production | `vercel env ls production \| grep SUPABASE_JWT_SECRET` |
| `OPENROUTER_API_KEY` set on Production (for OCR) | `vercel env ls production \| grep OPENROUTER_API_KEY` |
| `OPENROUTER_MODEL` (optional, overrides default model) | `vercel env ls production \| grep OPENROUTER_MODEL` |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set (for photo upload) | `vercel env ls production \| grep SUPABASE` |
| Two test images on disk (JPEG/PNG/WebP, < 10 MB each) | Any product photo — front label + ingredient panel |

If any env var is missing, the submission will fail silently (upload fails, OCR fails, or 401). Fix env vars before testing.

---

## Step 1 — Pull the JWT secret locally

Since Supabase uses HS256 (symmetric), you can sign a test token locally with the same secret the API uses to verify. No Expo login required.

```bash
cd /path/to/guardscan-api
cp .env.local .env.local.bak 2>/dev/null || true   # back up existing
vercel env pull .env.local
```

`vercel env pull` writes all production env vars to `.env.local` (gitignored). Your previous `.env.local` is preserved as `.env.local.bak`.

---

## Step 2 — Mint a test JWT

One-liner that reads `SUPABASE_JWT_SECRET` from `.env.local`, signs a 1-hour token with a synthetic `sub`, and exports it:

```bash
source .env.local   # loads SUPABASE_JWT_SECRET into the shell

export TOKEN=$(node -e '
const crypto = require("crypto");
const secret = process.env.SUPABASE_JWT_SECRET;
if (!secret) { console.error("SUPABASE_JWT_SECRET not set"); process.exit(1); }
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b64({ alg: "HS256", typ: "JWT" });
const p = b64({ sub: "test-user", exp: Math.floor(Date.now()/1000) + 3600 });
const s = crypto.createHmac("sha256", secret).update(h+"."+p).digest("base64url");
console.log(h+"."+p+"."+s);
')
echo "TOKEN length: ${#TOKEN}"   # expect ~180
```

The token only needs `sub` and `exp` per [lib/auth.ts](../../lib/auth.ts). `sub` can be any string — it lands in the `user_id` column of `user_submissions`.

---

## Step 3 — POST the submission

```bash
curl -sS -X POST https://guardscan-api.vercel.app/api/products/submit \
  -H "Authorization: Bearer $TOKEN" \
  -F "barcode=8006060654292" \
  -F "front=@/absolute/path/to/front.jpg" \
  -F "back=@/absolute/path/to/back.jpg" \
  -w "\n\nHTTP %{http_code}\n"
```

**Expected — HTTP 201:**

```json
{
  "submission_id": "e8f2…",
  "status": "pending_review",
  "message": "Thank you! We'll review your submission within 24 hours."
}
```

**If the barcode already exists in the catalog — HTTP 200:**

```json
{
  "status": "already_in_catalog",
  "product_id": "…",
  "message": "This product is already in our database."
}
```

This is the short-circuit at [app/api/products/submit/route.ts:44](../../app/api/products/submit/route.ts#L44). Pick a barcode that returns 404 from `/api/products/scan/:barcode` first.

---

## Step 4 — Verify the submission landed

```bash
npm run admin:submissions
```

Look for your `submission_id` with either a confidence score (OCR done) or `(OCR pending)` if you check within a few seconds of submission. OCR runs via `after()` so the HTTP response returns before Claude Vision completes.

If the row never gets an `ocr_text` field:

- Check Vercel function logs: `vercel logs --prod | grep submission_ocr`
- Most common cause: `ANTHROPIC_API_KEY` missing or rate-limited

---

## Step 5 — Review and publish

```bash
npm run admin:review -- <submission_id>
```

Interactive prompt — accepts Claude's pre-filled name/brand/category/ingredients or lets you override. Publishing writes to the `products` table via `upsertProduct` with `source: 'user'`.

After publishing, a fresh scan of the same barcode from the Expo app will hit the DB cache and return a full `ScanResult`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"error":"unauthorized"}` HTTP 401 | Missing/malformed Bearer token, or `SUPABASE_JWT_SECRET` on Vercel differs from your local copy | Re-run `vercel env pull .env.local` and re-mint the token |
| `{"error":"missing_fields"}` HTTP 400 | Curl `-F` path typo or file doesn't exist | Verify paths with `ls -la`; remember `@` prefix in `-F "front=@..."` |
| `{"error":"file_too_large"}` HTTP 413 | Image over 10 MB | Resize: `sips -Z 2000 input.jpg --out out.jpg` |
| `{"error":"unsupported_type"}` HTTP 415 | HEIC / other MIME | Convert to JPEG first |
| `{"status":"already_in_catalog"}` HTTP 200 | Barcode was previously published | Pick a barcode that 404s from `/api/products/scan` |
| 201 returned but `admin:submissions` empty | Local `DATABASE_URL` differs from production — check Transaction pooler URL | Verify `DATABASE_URL` in `.env.local` matches the pooler (port 6543) |
| OCR never populates | `OPENROUTER_API_KEY` missing on Vercel or upstream error | Check `vercel logs --prod \| grep submission_ocr_failed` |

---

## Notes

- This test intentionally **bypasses the Expo client**. It validates only the server pipeline. Wiring `capture: true` → submission UI in Expo is separate client work.
- **Never set `ALLOW_DEV_AUTH=true` on production** to shortcut this test — it would open the API to any `X-Dev-User-Id` header. The local JWT-minting approach above is the correct way.
- **Synthetic `sub` is safe for smoke tests** but if you later add a FK from `user_submissions.user_id` to `auth.users.id`, use a real Supabase user ID instead.
