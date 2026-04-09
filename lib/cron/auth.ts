/**
 * Cron request verification.
 *
 * Vercel sets `x-vercel-cron` on scheduled invocations. For manual triggers
 * in development, check for a `CRON_SECRET` bearer token.
 */

export function verifyCronRequest(request: Request): boolean {
  if (request.headers.get('x-vercel-cron') === '1') return true;

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth === `Bearer ${secret}`) return true;
  }

  return false;
}
