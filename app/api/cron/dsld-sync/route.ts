/**
 * GET /api/cron/dsld-sync — Weekly DSLD supplement ingest.
 *
 * Schedule: 0 5 * * 0 (Sundays at 5:00 AM UTC)
 *
 * Algorithm:
 *   1. Search DSLD with common supplement terms (paginated).
 *   2. For each hit, fetch the full label via /v9/label/{id}.
 *   3. Extract + normalize UPC, normalize product, upsert.
 *   4. Rate-limit label fetches (~600ms apart).
 *   5. Time-box at 4 minutes to stay under Vercel's 5-min cap.
 */

import { NextResponse } from 'next/server';

import { verifyCronRequest } from '@/lib/cron/auth';
import {
  batchUpsert,
  getCronState,
  setCronState,
  type IngestItem,
} from '@/lib/cron/ingest-helpers';
import { searchDsld, fetchDsldLabel, normalizeDsldUpc } from '@/lib/sources/dsld';
import { normalizeDsldLabel } from '@/lib/normalize';
import { scoreProduct } from '@/lib/scoring';
import { inferSubcategory } from '@/lib/subcategory';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const JOB_NAME = 'dsld_sync';

/** Search terms that cover the breadth of DSLD's catalog. */
const SEARCH_TERMS = [
  'vitamin',
  'mineral',
  'protein',
  'probiotic',
  'omega',
  'supplement',
  'capsule',
  'multivitamin',
  'magnesium',
  'zinc',
  'fish oil',
  'collagen',
  'creatine',
  'ashwagandha',
];

const DELAY_MS = 600; // Rate limit between label fetches
const TIME_LIMIT_MS = 240_000; // 4 minutes — leave margin

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!verifyCronRequest(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }

  const db = getDb();
  const startedAt = Date.now();

  // Track which DSLD IDs we've already processed in this run
  const processedIds = new Set<string>();
  let totalUpserted = 0;
  let totalErrors = 0;
  let totalSkipped = 0;
  let hitTimeLimit = false;

  try {
    // Resume from where we left off (search term index)
    const { metadata } = await getCronState(db, JOB_NAME);
    const lastTermIndex = (metadata as { lastTermIndex?: number })?.lastTermIndex ?? 0;

    for (let ti = lastTermIndex; ti < SEARCH_TERMS.length; ti++) {
      if (Date.now() - startedAt > TIME_LIMIT_MS) {
        hitTimeLimit = true;
        log.warn('dsld_sync_time_limit', { last_term_index: ti });
        // Save progress so next run resumes here
        await setCronState(db, JOB_NAME, null, 'partial', {
          lastTermIndex: ti,
          upserted: totalUpserted,
          errors: totalErrors,
          skipped: totalSkipped,
          duration_ms: Date.now() - startedAt,
        });
        break;
      }

      const term = SEARCH_TERMS[ti];
      log.info('dsld_sync_term', { term, index: ti });

      try {
        // Paginate through search results (max 200 per term to stay fast)
        let from = 0;
        const pageSize = 25;
        const maxPerTerm = 200;

        while (from < maxPerTerm) {
          if (Date.now() - startedAt > TIME_LIMIT_MS) {
            hitTimeLimit = true;
            break;
          }

          const { hits, total } = await searchDsld(term, {
            size: pageSize,
            from,
          });

          if (hits.length === 0) break;

          const items: IngestItem[] = [];

          for (const hit of hits) {
            if (processedIds.has(hit._id)) {
              totalSkipped++;
              continue;
            }
            processedIds.add(hit._id);

            try {
              await delay(DELAY_MS);

              const label = await fetchDsldLabel(hit._id);
              if (!label) continue;

              const barcode = normalizeDsldUpc(label.upcSku);
              if (!barcode) {
                totalSkipped++;
                continue; // No valid UPC — can't be scanned
              }

              const product = normalizeDsldLabel(label, barcode);
              if (product.data_completeness === 'barcode_only') continue;

              const score = scoreProduct({ product });
              const subcategory = inferSubcategory(
                product.name,
                product.category,
              );

              items.push({ product, source: 'dsld', score, subcategory });
            } catch (err) {
              log.warn('dsld_sync_label_failed', {
                dsld_id: hit._id,
                error: String(err),
              });
              totalErrors++;
            }
          }

          if (items.length > 0) {
            const result = await batchUpsert(db, items);
            totalUpserted += result.upserted;
            totalErrors += result.errors;
          }

          from += pageSize;
          if (from >= total) break;
        }
      } catch (err) {
        log.warn('dsld_sync_term_failed', { term, error: String(err) });
        totalErrors++;
      }
    }

    // Final state update (if we didn't hit the time limit and save partial)
    if (!hitTimeLimit) {
      await setCronState(db, JOB_NAME, null, totalErrors > 0 ? 'partial' : 'success', {
        lastTermIndex: 0, // Reset for next full run
        upserted: totalUpserted,
        errors: totalErrors,
        skipped: totalSkipped,
        duration_ms: Date.now() - startedAt,
      });
    }

    log.info('dsld_sync_done', {
      upserted: totalUpserted,
      errors: totalErrors,
      skipped: totalSkipped,
      duration_ms: Date.now() - startedAt,
      hitTimeLimit,
    });

    return NextResponse.json({
      status: 'ok',
      upserted: totalUpserted,
      errors: totalErrors,
      skipped: totalSkipped,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    log.error('dsld_sync_failed', { error: String(err) });
    await setCronState(db, JOB_NAME, null, 'failed', {
      error: String(err),
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'ingest_failed', message: String(err) },
      { status: 500 },
    );
  }
}
