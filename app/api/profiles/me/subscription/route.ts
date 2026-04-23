import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { profiles } from '@/db/schema';
import type { SubscriptionStatus, SubscriptionTier } from '@/types/guardscan';

/**
 * GET /api/profiles/me/subscription
 *
 * Returns the authenticated user's current subscription tier from the DB.
 * subscription_tier is kept current by the RevenueCat webhook
 * (POST /api/webhooks/revenuecat) — not by this endpoint.
 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const userId = auth.userId;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const db = getDb();
    const [row] = await db
      .select({ subscriptionTier: profiles.subscriptionTier })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    const status: SubscriptionStatus = {
      tier: (row?.subscriptionTier ?? 'free') as SubscriptionTier,
      expires_at: null,
    };

    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/profiles/me/subscription
 *
 * Optimistic client-side tier update after a RevenueCat purchase.
 * The RC webhook will later confirm or correct this value.
 * Body: { tier: 'free' | 'pro' }
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const userId = auth.userId;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { tier?: SubscriptionTier } = {};
  try {
    body = await request.json() as { tier?: SubscriptionTier };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const tier: SubscriptionTier = body.tier === 'pro' ? 'pro' : 'free';

  try {
    const db = getDb();
    await db
      .insert(profiles)
      .values({ userId, subscriptionTier: tier })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: { subscriptionTier: tier, updatedAt: sql`now()` },
      });

    const status: SubscriptionStatus = { tier, expires_at: null };
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}
