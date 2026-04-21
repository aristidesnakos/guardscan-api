/**
 * GET /api/ingredients/:normalized
 *
 * Returns enrichment metadata for a single ingredient from the in-memory
 * seed dictionary. Intended for the Expo detail sheet — the scan result
 * already carries flag/reason/fertility_relevant/testosterone_relevant,
 * so this endpoint returns only the Phase 1 enrichment fields.
 *
 * The `normalized` path param should be URL-encoded (e.g.
 * "sodium%20lauryl%20sulfate"). The lookup is case-insensitive and also
 * searches aliases, matching the same index used during scoring.
 *
 * Returns 404 when the ingredient is not in the curated dictionary.
 * Unknown/neutral ingredients are intentionally absent — the app should
 * not surface a detail page for unrecognized ingredients.
 */

import { NextResponse } from 'next/server';

import type { IngredientDetail } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { lookupIngredient } from '@/lib/dictionary/lookup';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ normalized: string }> },
) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const { normalized: raw } = await params;
  const normalized = decodeURIComponent(raw).toLowerCase().trim();

  try {
    const entry = lookupIngredient(normalized);

    if (!entry) {
      log.info('ingredient_detail_not_found', { normalized });
      return NextResponse.json(
        { error: 'not_found', normalized },
        { status: 404 },
      );
    }

    const detail: IngredientDetail = {
      normalized: entry.normalized,
      display_name: entry.aliases[0] ?? entry.normalized,
      ingredient_group: entry.ingredient_group,
      health_risk_tags: entry.health_risk_tags,
      description: entry.description ?? null,
      evidence_url: entry.evidence_url,
    };

    log.info('ingredient_detail', { normalized: entry.normalized });

    return NextResponse.json(detail, {
      headers: {
        // Seed data changes only on deploy — cache aggressively at CDN
        'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (err) {
    log.error('ingredient_detail_failed', { normalized, error: String(err) });
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500 },
    );
  }
}
