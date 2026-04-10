# Security Audit & Best Practices

> **Audit date:** 2026-04-10
> **Scope:** GuardScan API — Next.js 16 App Router backend
> **Commit:** `695c0fb` — _security: enforce auth by default, verify JWTs, add rate limiting_

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

## Environment Variable Security Checklist

| Variable | Required in Production | Purpose | Risk if Missing |
|---|---|---|---|
| `SUPABASE_JWT_SECRET` | Yes | JWT signature verification | All Bearer tokens accepted without verification |
| `CRON_SECRET` | Yes | Cron endpoint protection | Cron endpoints open to public trigger |
| `AUTH_ENABLED` | Do not set | Absence = auth on | Setting `true` is redundant; setting `false` disables auth |
| `ALLOW_DEV_AUTH` | Never | Dev `X-Dev-User-Id` bypass | Setting `true` in prod creates a public backdoor |
| `OFF_USER_AGENT` | Yes | Open Food Facts API identity | Requests may be blocked by upstream |
| `DATABASE_URL` | Yes (M1+) | Supabase connection | DB features silently disabled |

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
