import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import type { SubscriptionStatus, SubscriptionTier } from '@/types/guardscan';

/**
 * GET /api/profiles/me/subscription
 *
 * Returns the authenticated user's current subscription status.
 * Stub — always returns 'free' until RevenueCat server-side validation
 * is wired up (post-MVP).
 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const status: SubscriptionStatus = {
    tier: 'free',
    expires_at: null,
  };

  return NextResponse.json(status);
}

/**
 * POST /api/profiles/me/subscription
 *
 * Accepts a tier update from the client after a successful RevenueCat
 * purchase. Body: { tier: 'free' | 'pro' }
 *
 * Stub — echoes the requested tier back without persisting or verifying
 * the purchase receipt. Full implementation requires RevenueCat server-side
 * webhook or receipt validation (post-MVP).
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  let body: { tier?: SubscriptionTier } = {};
  try {
    body = await request.json() as { tier?: SubscriptionTier };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const tier: SubscriptionTier =
    body.tier === 'pro' ? 'pro' : 'free';

  const status: SubscriptionStatus = {
    tier,
    expires_at: null,
  };

  return NextResponse.json(status);
}
