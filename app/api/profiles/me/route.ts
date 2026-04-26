import { NextResponse } from 'next/server';
import { sql, eq } from 'drizzle-orm';
import { createClient } from '@supabase/supabase-js';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { profiles, scanEvents, userSubmissions } from '@/db/schema';
import type { UserProfile, DietaryApproach, LifeStage, SubscriptionTier } from '@/types/guardscan';

function rowToProfile(row: typeof profiles.$inferSelect): UserProfile {
  return {
    id: row.userId,
    user_id: row.userId,
    age: row.age ?? null,
    life_stage: row.lifeStage as LifeStage,
    trying_to_conceive: row.tryingToConceive,
    allergens: row.allergens ?? [],
    dietary_approach: row.dietaryApproach as DietaryApproach,
    subscription_tier: row.subscriptionTier as SubscriptionTier,
  };
}

/**
 * GET /api/profiles/me
 *
 * Returns the authenticated user's profile. Creates it with defaults on
 * first access (lazy creation — no separate sign-up webhook needed).
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
      .insert(profiles)
      .values({ userId })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: { updatedAt: sql`now()` },
      })
      .returning();

    return NextResponse.json(rowToProfile(row));
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/profiles/me
 *
 * Permanently deletes the authenticated user's account:
 * - Removes all user data from the database (scan history, submissions, profile)
 * - Deletes the Supabase Auth user via the admin API
 *
 * This satisfies App Store guideline 5.1.1(v).
 */
export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const userId = auth.userId;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const db = getDb();

    // Delete all user-owned rows. Order: child tables first, then profile.
    await db.delete(scanEvents).where(eq(scanEvents.userId, userId));
    await db.delete(userSubmissions).where(eq(userSubmissions.userId, userId));
    await db.delete(profiles).where(eq(profiles.userId, userId));

    // Delete the Supabase Auth user (requires service role key).
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey) {
      const adminClient = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
      });
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) {
        console.error('[DELETE /api/profiles/me] supabase deleteUser error:', error.message);
        // Don't fail the request — DB data is already gone.
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/profiles/me
 *
 * Updates mutable health profile fields.
 * Body (all optional): { age, life_stage, trying_to_conceive, allergens, dietary_approach }
 */
export async function PUT(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const userId = auth.userId;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Partial<{
    age: number | null;
    life_stage: string;
    trying_to_conceive: boolean;
    allergens: string[];
    dietary_approach: string;
  }> = {};

  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Build only the fields that were explicitly provided
  const updates: Record<string, unknown> = { updatedAt: sql`now()` };
  if (body.age !== undefined) updates.age = body.age;
  if (body.life_stage !== undefined) updates.lifeStage = body.life_stage;
  if (body.trying_to_conceive !== undefined) updates.tryingToConceive = body.trying_to_conceive;
  if (body.allergens !== undefined) updates.allergens = body.allergens;
  if (body.dietary_approach !== undefined) updates.dietaryApproach = body.dietary_approach;

  try {
    const db = getDb();

    const [row] = await db
      .insert(profiles)
      .values({ userId, ...updates })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: updates,
      })
      .returning();

    return NextResponse.json(rowToProfile(row));
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}
