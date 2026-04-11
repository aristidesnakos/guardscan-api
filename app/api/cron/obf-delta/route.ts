/**
 * GET /api/cron/obf-delta — Daily OBF delta ingest.
 *
 * Schedule: 0 3 * * * (daily at 3:00 AM UTC)
 *
 * Algorithm:
 *   1. Fetch delta index from OBF static exports.
 *   2. Process only files newer than the last run (tracked in cron_state).
 *   3. For each delta file: decompress, parse JSONL, normalize, score, upsert.
 *   4. Update cron_state with last processed filename.
 */

import { NextResponse } from 'next/server';

import { verifyCronRequest } from '@/lib/cron/auth';
import {
  fetchGzipJsonl,
  batchUpsert,
  getCronState,
  setCronState,
  type IngestItem,
} from '@/lib/cron/ingest-helpers';
import { normalizeObfProduct } from '@/lib/normalize';
import { scoreProduct } from '@/lib/scoring';
import { inferSubcategory } from '@/lib/subcategory';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { log } from '@/lib/logger';
import type { ObfProduct } from '@/lib/sources/openbeautyfacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OBF_DELTA_INDEX = 'https://static.openbeautyfacts.org/data/delta/index.txt';
const OBF_DELTA_BASE = 'https://static.openbeautyfacts.org/data/delta';
const JOB_NAME = 'obf_delta';

export async function GET(request: Request) {
  if (!verifyCronRequest(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: 'database_not_configured' }, { status: 503 });
  }

  const db = getDb();
  const startedAt = Date.now();

  try {
    // 1. Fetch delta index
    const indexResponse = await fetch(OBF_DELTA_INDEX, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!indexResponse.ok) {
      throw new Error(`Delta index returned HTTP ${indexResponse.status}`);
    }
    const indexText = await indexResponse.text();
    const allFiles = indexText
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .sort(); // chronological by timestamp in filename

    if (allFiles.length === 0) {
      log.info('obf_delta_no_files');
      await setCronState(db, JOB_NAME, null, 'success', { files: 0, products: 0 });
      return NextResponse.json({ status: 'ok', files: 0, products: 0 });
    }

    // 2. Determine which files to process
    const { lastProcessedKey } = await getCronState(db, JOB_NAME);
    const newFiles = lastProcessedKey
      ? allFiles.filter((f) => f > lastProcessedKey)
      : allFiles.slice(-1); // First run: only process the most recent file

    if (newFiles.length === 0) {
      log.info('obf_delta_up_to_date');
      return NextResponse.json({ status: 'ok', files: 0, products: 0 });
    }

    log.info('obf_delta_start', { files_to_process: newFiles.length });

    let totalUpserted = 0;
    let totalErrors = 0;
    let lastFile = lastProcessedKey;

    // 3. Process each delta file
    for (const filename of newFiles) {
      const url = `${OBF_DELTA_BASE}/${filename}`;

      try {
        const rawProducts = await fetchGzipJsonl<ObfProduct>(url);
        log.info('obf_delta_file', { filename, products: rawProducts.length });

        // Process in batches of 50
        const batchSize = 50;
        for (let i = 0; i < rawProducts.length; i += batchSize) {
          const batch = rawProducts.slice(i, i + batchSize);
          const items: IngestItem[] = [];

          for (const raw of batch) {
            const barcode = raw.code;
            if (!barcode || !/^\d{6,14}$/.test(barcode)) continue;

            const product = normalizeObfProduct(raw, barcode);
            if (product.data_completeness === 'barcode_only') continue;

            const score = scoreProduct({ product });
            const subcategory = inferSubcategory(
              product.name,
              product.category,
            );

            items.push({ product, source: 'obf', score, subcategory });
          }

          if (items.length > 0) {
            const result = await batchUpsert(db, items);
            totalUpserted += result.upserted;
            totalErrors += result.errors;
          }
        }

        lastFile = filename;
      } catch (err) {
        log.warn('obf_delta_file_failed', {
          filename,
          error: String(err),
        });
        totalErrors++;
      }

      // Time guard: stop if we're approaching the 5-minute limit
      if (Date.now() - startedAt > 240_000) {
        log.warn('obf_delta_time_limit', { processed_files: newFiles.indexOf(filename) + 1 });
        break;
      }
    }

    // 4. Update cron state
    const status = totalErrors > 0 ? 'partial' : 'success';
    await setCronState(db, JOB_NAME, lastFile, status as 'success' | 'partial', {
      files: newFiles.length,
      upserted: totalUpserted,
      errors: totalErrors,
      duration_ms: Date.now() - startedAt,
    });

    log.info('obf_delta_done', {
      upserted: totalUpserted,
      errors: totalErrors,
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json({
      status: 'ok',
      upserted: totalUpserted,
      errors: totalErrors,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    log.error('obf_delta_failed', { error: String(err) });
    await setCronState(db, JOB_NAME, null, 'failed', {
      error: String(err),
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'ingest_failed' },
      { status: 500 },
    );
  }
}
