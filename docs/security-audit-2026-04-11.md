# Security Audit — 2026-04-11

> **Scope:** Full route + auth layer review, GuardScan API (Next.js 16 App Router)
> **Prior audit:** [`docs/architecture/security.md`](architecture/security.md) — 2026-04-10

---

## Fixes Applied in This Session

### V-06 · JWT `alg` header not validated (Critical → Fixed)

**File:** [`lib/auth.ts`](../lib/auth.ts)

**Risk:** The JWT verifier never inspected the `alg` claim in the token header. A token carrying `alg: "none"` or `alg: "RS256"` would reach the `crypto.subtle.verify(HMAC …)` call. While the HMAC verify step would likely fail for a tampered token, relying on that as the sole defence is fragile — the explicit algorithm check is the correct first gate.

**Fix:** The header is now decoded and checked before any cryptographic work:

```ts
// lib/auth.ts — verifyJwt()
let header: unknown;
try {
  header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
} catch {
  return null;
}
if (
  typeof header !== 'object' ||
  header === null ||
  (header as Record<string, unknown>)['alg'] !== 'HS256'
) {
  return null;
}
```

Any token with a missing, wrong, or forged `alg` claim is rejected outright before touching the secret.

**Pattern:** Always pin the algorithm explicitly. The `alg: "none"` attack is a classic JWT pitfall precisely because many verifiers trust the header instead of enforcing a known-good value.

---

### V-07 · `AUTH_DISABLED=true` permitted in production (High → Fixed)

**File:** [`lib/auth.ts`](../lib/auth.ts)

**Risk:** `AUTH_ENABLED=false` disables all authentication checks. There was no safeguard preventing this from being set on a production Vercel deployment, either accidentally or via a misconfigured CI pipeline. A single environment variable typo could silently open every endpoint to anonymous callers.

**Fix:** A module-level guard throws at server startup if auth is disabled while `NODE_ENV === 'production'`:

```ts
if (AUTH_DISABLED && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_ENABLED=false is not permitted in production. Remove the variable or set it to any value other than "false".',
  );
}
```

The throw happens during module initialisation, so the function cold-start will fail loudly and Vercel will surface it as a deployment/invocation error rather than silently serving unauthenticated responses.

**Pattern:** Security controls that must never be active in production should fail-fast at startup, not silently degrade at request time.

---

### V-08 · Raw exception messages returned to API clients (High → Fixed)

**Files:**
- [`app/api/products/[id]/route.ts`](../app/api/products/%5Bid%5D/route.ts)
- [`app/api/recommendations/route.ts`](../app/api/recommendations/route.ts)
- [`app/api/cron/obf-delta/route.ts`](../app/api/cron/obf-delta/route.ts)
- [`app/api/cron/dsld-sync/route.ts`](../app/api/cron/dsld-sync/route.ts)

**Risk:** Four catch blocks were serialising the raw exception via `String(err)` into the JSON response body under a `message` key. PostgreSQL errors include table names, column names, and constraint identifiers. Node.js errors include file paths and stack frames. This information helps an attacker understand the schema and internal structure of the application.

**Fix:** All four response bodies now return only the opaque error code. The full error string is retained in the server-side log call immediately above each return, so Vercel log drains still receive the detail.

```ts
// Before
{ error: 'internal_error', message: String(err) }

// After
{ error: 'internal_error' }
```

**Pattern:** Log verbosely server-side; respond minimally client-side. The client only needs to know *that* something failed and which error code to surface — never *why* at the implementation level.

---

## Open Findings (Not Fixed Here)

These issues were identified but are either intentional, low-impact given the current architecture, or require broader changes outside a security patch.

| ID | Issue | File | Severity | Notes |
|----|-------|------|----------|-------|
| O-01 | CORS `Access-Control-Allow-Origin: *` | `proxy.ts` | Low (intentional) | Documented as acceptable for a bearer-token API in `architecture/security.md` §CORS. Revisit if cookie-based auth is ever added. |
| O-02 | In-memory rate limiting not distributed | `proxy.ts` | Medium | Per-instance only; multi-instance bypass possible. Upgrade path to `@upstash/ratelimit` is already documented in `architecture/security.md`. |
| O-03 | No max length on search query param | `app/api/products/search/suggestions/route.ts` | Medium | No upper bound on `q=`. Add `rawQuery.length > 100` guard. |
| O-04 | `.passthrough()` on OFF/OBF Zod schemas | `lib/sources/openfoodfacts.ts` | Medium | Unknown fields from third-party APIs flow into DB. Switch to `.strip()` (Zod default) or `.strict()`. |
| O-05 | No per-user rate limit on `/api/products/submit` | `app/api/products/submit/route.ts` | Medium | File upload endpoint has no submission frequency cap per authenticated user. |
| O-06 | Barcode validation has no checksum | `app/api/products/scan/[barcode]/route.ts` | Low | `/^\d{6,14}$/` accepts any digit string. Add EAN-13 / UPC-A Luhn check to reject non-product codes earlier. |
| O-07 | Long-running DSLD cron in serverless function | `app/api/cron/dsld-sync/route.ts` | Low (reliability) | The DSLD sync polls in a loop inside a single Vercel Function invocation. Consider migrating to Vercel Workflow for durable step-based execution with automatic retries. |
| O-08 | Missing HTTP security headers | All routes | Low | No `Strict-Transport-Security`, `X-Content-Type-Options`, or `X-Frame-Options`. Add in `proxy.ts` response headers or `next.config.ts` `headers()`. |

---

## Environment Variable Security Additions

The following additions to the variable table in `architecture/security.md` are recommended:

| Variable | Required in Production | Risk if Wrong |
|---|---|---|
| `AUTH_ENABLED` | Must not be set to `false` | Setting `false` now throws at startup in production (V-07 fix) |
| `NODE_ENV` | Set to `production` by Vercel automatically | If unset or set to `development`, the V-07 guard does not fire |

---

## Verification

To confirm V-06 (alg bypass): craft a JWT with header `{"alg":"none"}` and a valid payload — `verifyJwt` now returns `null` immediately.

To confirm V-07 (prod guard): set `AUTH_ENABLED=false` and `NODE_ENV=production` locally — the module throws on import.

To confirm V-08 (error leak): trigger a DB error on any patched endpoint — the response body contains only `{"error":"…"}` with no `message` field.
