/**
 * GET /api/products/search/suggestions
 *
 * Autocomplete for the search tab. Called by the Expo client every time
 * the user types (debounced on the client at 200ms). Prefix-biased:
 *   - Query is matched against `products.name` and `products.brand` with
 *     an `ILIKE 'q%'` pattern — full substring search lives in the
 *     regular /search endpoint.
 *   - We only surface products with `score IS NOT NULL` so the dropdown
 *     never shows "mystery products" the scan tab can't explain.
 *
 * Response shape matches the Expo client's `SearchSuggestion[]` contract
 * (see types/guardscan.ts). The client renders each entry with
 * HighlightedText, using matchStart/matchEnd to bold the matched span,
 * and puts `text` back into the search field when the user taps a row.
 *
 * Deliberately NOT wrapped in `{ suggestions: [...] }` — the cucumberdude
 * client calls `get<SearchSuggestion[]>(...)` and expects the bare array.
 *
 * Caching: 60s shared cache + 5min SWR is enough for interactive typing
 * without starving the autocomplete of fresh inserts after a Task 2
 * rescore backfill.
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, ilike, isNotNull, or } from 'drizzle-orm';

import type { ProductCategory, SearchSuggestion } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { products } from '@/db/schema';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_CATEGORIES: readonly ProductCategory[] = [
  'food',
  'grooming',
  'supplement',
];

const MIN_QUERY_LENGTH = 2;
const MAX_SUGGESTIONS = 8;
// Overfetch so we have headroom to dedupe near-duplicate product names
// without falling below MAX_SUGGESTIONS.
const OVERFETCH_LIMIT = 24;

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
};

/**
 * Escape SQL LIKE wildcards so user input like "50% off" doesn't get
 * interpreted as a broad pattern. Drizzle's ilike() binds the pattern
 * as a parameter but the wildcard interpretation happens at the DB
 * layer, so the escape must happen here.
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, '\\$&');
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const rawQuery = (url.searchParams.get('q') ?? '').trim();
  const categoryParam = url.searchParams.get('category');

  if (rawQuery.length < MIN_QUERY_LENGTH) {
    return NextResponse.json([], { headers: CACHE_HEADERS });
  }

  const category =
    categoryParam &&
    (VALID_CATEGORIES as readonly string[]).includes(categoryParam)
      ? (categoryParam as ProductCategory)
      : null;

  if (!isDatabaseConfigured()) {
    return NextResponse.json([], { headers: CACHE_HEADERS });
  }

  const pattern = `${escapeLikePattern(rawQuery)}%`;
  const db = getDb();

  const whereClauses = [
    isNotNull(products.score),
    or(ilike(products.name, pattern), ilike(products.brand, pattern)),
  ];
  if (category) {
    whereClauses.push(eq(products.category, category));
  }

  try {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        brand: products.brand,
      })
      .from(products)
      .where(and(...whereClauses))
      .orderBy(desc(products.score), products.name)
      .limit(OVERFETCH_LIMIT);

    const lowerQuery = rawQuery.toLowerCase();
    const seen = new Set<string>();
    const suggestions: SearchSuggestion[] = [];

    for (const row of rows) {
      // Prefer the product name when it matches; fall back to the brand
      // if only the brand matched (e.g. typing "old" when a product is
      // named "Sport Deodorant" but the brand is "Old Spice").
      const nameIdx = row.name.toLowerCase().indexOf(lowerQuery);
      let text: string;
      let matchIdx: number;
      if (nameIdx !== -1) {
        text = row.name;
        matchIdx = nameIdx;
      } else {
        const brand = row.brand ?? '';
        const brandIdx = brand.toLowerCase().indexOf(lowerQuery);
        if (brandIdx === -1) continue;
        text = brand;
        matchIdx = brandIdx;
      }

      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      suggestions.push({
        text,
        matchStart: matchIdx,
        matchEnd: matchIdx + rawQuery.length,
      });

      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }

    log.info('search_suggestions', {
      q: rawQuery,
      category,
      returned: suggestions.length,
      candidates: rows.length,
    });

    return NextResponse.json(suggestions, { headers: CACHE_HEADERS });
  } catch (err) {
    // Fail-soft: return an empty list on DB blips. A dropped autocomplete
    // row is dramatically better UX than popping an error alert in the
    // Expo app while the user is mid-typing. The error is still logged
    // so Vercel log drains pick it up.
    log.error('search_suggestions_failed', {
      q: rawQuery,
      category,
      error: String(err),
    });
    return NextResponse.json([], { headers: CACHE_HEADERS });
  }
}
