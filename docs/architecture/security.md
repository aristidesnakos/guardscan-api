# Security Audit & Best Practices

> **Scope:** GuardScan API — Next.js 16 App Router backend
> **Initial audit:** 2026-04-10 — _security: enforce auth by default, verify JWTs, add rate limiting_ (commit `695c0fb`)
> **Follow-up audit:** 2026-04-11 — _security: JWT alg pinning, production auth guard, error-body hardening_ (commit `cd8c6e5`)
>
> This document is the single source of truth for the security posture of the API. Findings are numbered chronologically (V-01 → V-NN) and resolved findings stay in the document as a historical audit trail.

---

## Vulnerabilities Found & Resolved

### V-01 · Auth disabled by default (Critical)

**Risk:** Any unauthenticated caller could hit every endpoint freely, generating Vercel invocation costs, external API calls (Open Food Facts, Open Beauty Facts), and database load.

**Root cause:** `lib/auth.ts` used opt-in auth:
```ts
// BEFORE — dangerous default
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
if (!AUTH_ENABLED) return ctx; // anonymous callers passed through
```
If `AUTH_ENABLED` was not explicitly set in the environment (a common omission), all routes were fully open.

**Fix:** Inverted to opt-out. Auth is enforced unless explicitly disabled:
```ts
// AFTER — safe default
const AUTH_DISABLED = process.env.AUTH_ENABLED === 'false';
```
Setting `AUTH_ENABLED=false` is now a conscious decision. Not setting it means auth is on.

**Pattern:** **Default-deny, explicit-allow.** Security controls should fail closed, not open. Never use a string equality check like `=== 'true'` to enable security — use `!== 'false'` to disable it.

---

### V-02 · Bearer tokens accepted without verification (Critical)

**Risk:** Any string passed as `Authorization: Bearer <anything>` was accepted. The `userId` was hardcoded to the string literal `'unverified'` rather than the actual user's identity. An attacker could forge any user context.

**Root cause:**
```ts
// BEFORE — accepted without any signature check
if (authHeader?.startsWith('Bearer ')) {
  return { userId: 'unverified', source: 'bearer' };
}
```

**Fix:** JWTs are now cryptographically verified against `SUPABASE_JWT_SECRET` using the Web Crypto API (HS256/HMAC-SHA256). Expired tokens (`exp` claim) are also rejected. No new dependencies required — `crypto.subtle` is available in Node.js 18+ and the Next.js runtime.

```ts
// AFTER — signature + expiry verified
const payload = await verifyJwt(authHeader.slice(7));
if (payload) return { userId: payload.sub, source: 'bearer' };
```

**Pattern:** **Never trust, always verify.** A token is not proof of identity until its signature is validated against the signing secret. Setting `userId` to a constant instead of a verified claim is equivalent to no auth at all.

---

### V-03 · Permanent dev backdoor in production (Critical)

**Risk:** The `X-Dev-User-Id` header was accepted unconditionally in all environments. Any caller — browser scripts, bots, other services — could send this header and bypass auth entirely, impersonating any user ID. The header was also advertised in `Access-Control-Allow-Headers: X-Dev-User-Id`, explicitly inviting browsers to use it.

**Root cause:** No guard existed on the dev bypass mechanism. It was always active.

**Fix:** The header is now gated behind a separate env var:
```ts
const DEV_AUTH_ALLOWED = process.env.ALLOW_DEV_AUTH === 'true';

if (DEV_AUTH_ALLOWED) {
  const devId = request.headers.get('x-dev-user-id');
  if (devId) return { userId: devId, source: 'dev' };
}
```
`ALLOW_DEV_AUTH=true` must only be set in `.env.local` for local development. The header was also removed from `proxy.ts` CORS headers.

**Pattern:** **Dev conveniences must be environment-scoped.** Any bypass mechanism — dev tokens, magic headers, skeleton keys — must be impossible to activate in production. Use separate env vars controlled per-environment, never a single code path that runs everywhere.

---

### V-04 · Cron endpoints triggerable by any HTTP client (High)

**Risk:** Both `/api/cron/obf-delta` and `/api/cron/dsld-sync` are 300-second max-duration functions that hammer external APIs and perform bulk database writes. An attacker sending a single spoofed header could trigger these at will, causing significant cost and load.

**Root cause:**
```ts
// BEFORE — x-vercel-cron is just a plain HTTP header, trivially spoofable
if (request.headers.get('x-vercel-cron') === '1') return true;
```
The `x-vercel-cron` header provides no cryptographic guarantee — any HTTP client can set any header. Additionally, `CRON_SECRET` was optional: if unset, the secret check was skipped entirely.

**Fix:** Removed the header bypass entirely. `CRON_SECRET` is now required:
```ts
// AFTER — secret required, no header shortcut
const secret = process.env.CRON_SECRET;
if (!secret) return false; // reject all if secret unset

const auth = request.headers.get('authorization');
return auth === `Bearer ${secret}`;
```
Vercel automatically forwards `Authorization: Bearer <CRON_SECRET>` on all scheduled invocations when the secret is configured.

**Pattern:** **Never authenticate on headers you don't control.** Any header can be set by any client. Authentication must rely on shared secrets or cryptographic signatures, not flag-style headers. Long-running or resource-intensive endpoints deserve stricter auth than regular API routes.

---

### V-05 · No rate limiting (High)

**Risk:** With auth disabled by default (V-01), the scan endpoint was effectively a free, unlimited proxy to Open Food Facts and Open Beauty Facts, plus a free Vercel compute allocation. Even with auth enabled, a compromised or misbehaving authenticated client could generate excessive costs.

**Root cause:** No rate limiting existed at any layer.

**Fix:** IP-based sliding-window rate limiting added to `proxy.ts` (the Next.js 16 request interception layer), covering all `/api/*` routes before they reach route handlers:

- `/api/products/scan/*` — **20 requests/minute/IP** (most expensive: 2 external API calls + DB write per request)
- All other API routes — **60 requests/minute/IP**
- `/api/health` — exempt
- Returns `429 Too Many Requests` with `Retry-After: 60`

**Limitation:** State is per-serverless-instance. This protects against single-instance floods but is not coordinated across concurrent instances. For distributed rate limiting at scale, replace with `@upstash/ratelimit` backed by Upstash Redis.

**Pattern:** **Rate limit at the earliest possible layer.** Apply limits in middleware/proxy before requests reach business logic. Choose limits based on the cost of each operation, not a uniform value. Always return `Retry-After` so clients can back off gracefully.

---

### V-06 · JWT `alg` header not validated (Critical)

**Audit:** 2026-04-11 · **File:** [`lib/auth.ts`](../../lib/auth.ts)

**Risk:** The JWT verifier never inspected the `alg` claim in the token header. A token carrying `alg: "none"` or `alg: "RS256"` would reach the `crypto.subtle.verify(HMAC …)` call. The HMAC verify step would likely fail for a tampered token, but relying on that as the sole defence is fragile — the explicit algorithm check is the correct first gate.

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

**Pattern:** **Always pin the algorithm explicitly.** The `alg: "none"` attack is a classic JWT pitfall precisely because many verifiers trust the header instead of enforcing a known-good value.

---

### V-07 · `AUTH_ENABLED=false` permitted in production (High)

**Audit:** 2026-04-11 · **File:** [`lib/auth.ts`](../../lib/auth.ts)

**Risk:** Setting `AUTH_ENABLED=false` disables all authentication checks. There was no safeguard preventing this from being set on a production Vercel deployment, either accidentally or via a misconfigured CI pipeline. A single environment variable typo could silently open every endpoint to anonymous callers.

**Fix:** A module-level guard throws at server startup if auth is disabled while `NODE_ENV === 'production'`:

```ts
if (AUTH_DISABLED && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_ENABLED=false is not permitted in production. Remove the variable or set it to any value other than "false".',
  );
}
```

The throw happens during module initialization, so the function cold-start will fail loudly and Vercel will surface it as a deployment/invocation error rather than silently serving unauthenticated responses.

**Pattern:** **Security controls that must never be active in production should fail-fast at startup**, not silently degrade at request time.

---

### V-08 · Raw exception messages returned to API clients (High)

**Audit:** 2026-04-11 · **Files:**
- [`app/api/products/[id]/route.ts`](../../app/api/products/%5Bid%5D/route.ts)
- [`app/api/recommendations/route.ts`](../../app/api/recommendations/route.ts)
- [`app/api/cron/obf-delta/route.ts`](../../app/api/cron/obf-delta/route.ts)
- [`app/api/cron/dsld-sync/route.ts`](../../app/api/cron/dsld-sync/route.ts)

**Risk:** Four catch blocks were serializing the raw exception via `String(err)` into the JSON response body under a `message` key. PostgreSQL errors include table names, column names, and constraint identifiers. Node.js errors include file paths and stack frames. This information helps an attacker understand the schema and internal structure of the application.

**Fix:** All four response bodies now return only the opaque error code. The full error string is retained in the server-side log call immediately above each return, so Vercel log drains still receive the detail.

```ts
// Before
{ error: 'internal_error', message: String(err) }

// After
{ error: 'internal_error' }
```

**Pattern:** **Log verbosely server-side; respond minimally client-side.** The client only needs to know *that* something failed and which error code to surface — never *why* at the implementation level.

---

## Open Findings (Not Yet Fixed)

These issues were identified during the 2026-04-11 follow-up audit. Each is either intentional, low-impact given the current architecture, or requires broader changes outside a security patch.

| ID | Issue | File | Severity | Notes |
|----|-------|------|----------|-------|
| O-01 | CORS `Access-Control-Allow-Origin: *` | `proxy.ts` | Low (intentional) | Acceptable for a bearer-token API (see §CORS below). Revisit if cookie-based auth is ever added. |
| O-02 | In-memory rate limiting not distributed | `proxy.ts` | Medium | Per-instance only; multi-instance bypass possible. Upgrade path to `@upstash/ratelimit` documented below. |
| O-03 | No max length on search query param | `app/api/products/search/suggestions/route.ts` | Medium | No upper bound on `q=`. Add a `rawQuery.length > 100` guard. |
| O-04 | `.passthrough()` on OFF/OBF Zod schemas | `lib/sources/openfoodfacts.ts` | Medium | Unknown fields from third-party APIs flow into DB. Switch to `.strip()` (Zod default) or `.strict()`. |
| O-05 | No per-user rate limit on `/api/products/submit` | `app/api/products/submit/route.ts` | Medium | File upload endpoint has no per-user submission frequency cap. |
| O-06 | Barcode validation has no checksum | `app/api/products/scan/[barcode]/route.ts` | Low | `/^\d{6,14}$/` accepts any digit string. Add EAN-13 / UPC-A check-digit validation to reject non-product codes earlier. |
| O-07 | Long-running DSLD cron in serverless function | `app/api/cron/dsld-sync/route.ts` | Low (reliability) | Polls in a loop inside a single invocation. Consider migrating to Vercel Workflow for durable step-based execution with automatic retries. |
| O-08 | Missing HTTP security headers | All routes | Low | No `Strict-Transport-Security`, `X-Content-Type-Options`, or `X-Frame-Options`. Add in `proxy.ts` response headers or `next.config.ts` `headers()`. |

---

## Environment Variable Security Checklist

| Variable | Required in Production | Purpose | Risk if Wrong |
|---|---|---|---|
| `SUPABASE_JWT_SECRET` | Yes | JWT signature verification | All Bearer tokens accepted without verification |
| `CRON_SECRET` | Yes | Cron endpoint protection | Cron endpoints open to public trigger |
| `AUTH_ENABLED` | Do not set (or not `false`) | Absence = auth on | Setting `false` now throws at startup in production (V-07 fix) |
| `ALLOW_DEV_AUTH` | Never | Dev `X-Dev-User-Id` bypass | Setting `true` in prod creates a public backdoor |
| `NODE_ENV` | `production` (set by Vercel) | Enables the V-07 startup guard | If unset or `development`, the V-07 guard does not fire |
| `OFF_USER_AGENT` | Yes | Open Food Facts API identity | Requests may be blocked by upstream |
| `DATABASE_URL` | Yes | Supabase connection | DB features silently disabled |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Yes | Submission photo storage | `/api/products/submit` fails |
| `OPENROUTER_API_KEY` | Yes | Claude Vision OCR | Submissions fall back to manual review |
| `ADMIN_USER_IDS` | Yes | Admin gate for admin endpoints / CLI | Admin ops cannot authenticate |

---

## Best Practices for Future Endpoints

### Authentication
1. Every new route handler must call `await requireUser(request)` as its first statement.
2. Check `auth instanceof NextResponse` immediately after and return if true.
3. If the endpoint requires a known user (not just any auth), additionally check `if (!auth.userId)` and return 401.
4. Never add new bypass mechanisms. If a route must be public, explicitly document why and skip `requireUser`.

### Secrets and tokens
1. Verify every token cryptographically — never trust a claim without checking its signature.
2. Always check token expiry (`exp` claim).
3. Never log tokens, JWTs, or secrets — only log the user ID extracted from a verified token.
4. Rotate `CRON_SECRET` if it's ever exposed. Generate with `openssl rand -hex 32`.

### Cron / background jobs
1. `CRON_SECRET` must be set before any cron route is deployed.
2. Never add a `x-vercel-cron` header bypass — Vercel sends the secret automatically.
3. Long-running routes (`maxDuration > 60s`) should have extra scrutiny on auth since they're disproportionately expensive to trigger.

### Rate limiting
1. The proxy-level rate limiter covers all routes automatically. No per-route work needed.
2. If adding an especially expensive endpoint (external API call, large DB scan, file upload), consider adding a tighter per-route check.
3. For distributed/multi-instance deployments, upgrade to `@upstash/ratelimit`.

### CORS
1. Do not add headers to `Access-Control-Allow-Headers` unless a route actively uses and validates them.
2. `X-Dev-User-Id` must never appear in CORS headers in production.
3. `Access-Control-Allow-Origin: *` is acceptable for a public-read API; if the API becomes private, restrict to specific origins via `APP_ORIGIN`.

### Smoke testing
- Use `SMOKE_DEV_USER_ID=<any-string>` in `.env.local` with `ALLOW_DEV_AUTH=true` for local runs.
- Use `SMOKE_AUTH_TOKEN=<real-jwt>` for CI/staging runs against deployed environments.
- A 401 response from the smoke test means auth is working correctly but credentials weren't passed — not a code bug.

---

## Upgrade Path: Distributed Rate Limiting

The current in-memory rate limiter is sufficient for early-stage traffic. When the app scales to multiple concurrent serverless instances, replace it with:

```bash
npm install @upstash/ratelimit @upstash/redis
vercel integration add upstash
```

The swap in `proxy.ts` is ~10 lines — the interface is the same, the backing store becomes Redis coordinated across all instances.

---

## Verification

Quick checks to confirm the most recent fixes are active:

- **V-06 (alg bypass):** craft a JWT with header `{"alg":"none"}` and a valid payload — `verifyJwt` returns `null` immediately.
- **V-07 (prod guard):** set `AUTH_ENABLED=false` and `NODE_ENV=production` locally — the module throws on import.
- **V-08 (error leak):** trigger a DB error on any patched endpoint — the response body contains only `{"error":"…"}` with no `message` field.
