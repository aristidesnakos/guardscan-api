/**
 * Cron request verification.
 *
 * CRON_SECRET must be set. Vercel automatically sends it as
 * `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation.
 * For manual/local triggers, pass the same header.
 *
 * The `x-vercel-cron` header is NOT used for auth — it is a plain HTTP
 * header that any client can spoof and provides no real security guarantee.
 */

export function verifyCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // Reject all requests if secret is unset

  const auth = request.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}
