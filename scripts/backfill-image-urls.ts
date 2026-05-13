/**
 * Backfill image_front for products where it's NULL.
 *
 * The frontend's image-fidelity benchmark (cucumberdude repo) showed that
 * Open Beauty Facts has a real front-of-pack photo for ~86% of catalog rows
 * that currently store NULL in image_front. Until 2026-05-13 the OBF delta
 * cron silently dropped products that lacked ingredients — including their
 * image_url — leaving the column null forever. The cron filter is now fixed,
 * but new ingests won't help rows already stuck null.
 *
 * Walks `products WHERE image_front IS NULL`, re-fetches OBF (and OFF as a
 * second try), and updates rows with `image_front_url`. Idempotent — skips
 * any row that already has a value, and skips DSLD/user-submitted rows where
 * we don't expect an OFF/OBF photo to exist.
 *
 * Usage:
 *   npx tsx scripts/backfill-image-urls.ts                # apply, all rows
 *   npx tsx scripts/backfill-image-urls.ts --dry          # preview only
 *   npx tsx scripts/backfill-image-urls.ts --limit=100    # cap at N
 *   npx tsx scripts/backfill-image-urls.ts --source=obf   # only obf-sourced
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { products } from '@/db/schema';
import { fetchObfProduct } from '@/lib/sources/openbeautyfacts';
import { fetchOffProduct } from '@/lib/sources/openfoodfacts';

type SourceFilter = 'obf' | 'off' | 'all';

function parseArgs() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : null;
  const sourceArg = args.find((a) => a.startsWith('--source='));
  const source = (sourceArg?.slice('--source='.length) as SourceFilter) ?? 'all';
  return { dry, limit, source };
}

async function fetchImageUrl(barcode: string): Promise<{ url: string; via: 'obf' | 'off' } | null> {
  // OBF first — this is the grooming catalog, OBF will hit more often.
  try {
    const obf = await fetchObfProduct(barcode);
    if (obf?.image_front_url) return { url: obf.image_front_url, via: 'obf' };
  } catch {
    // network / 404 / schema — fall through to OFF
  }
  try {
    const off = await fetchOffProduct(barcode);
    if (off?.image_front_url) return { url: off.image_front_url, via: 'off' };
  } catch {
    // give up on this row
  }
  return null;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { dry, limit, source } = parseArgs();
  const db = getDb();

  // Source filter — by default scan everything that *could* have an OBF/OFF
  // photo (skip dsld which doesn't, skip user-submitted which has its own
  // backfill in backfill-submission-images.ts).
  const sourceCondition =
    source === 'obf'
      ? eq(products.source, 'obf')
      : source === 'off'
        ? eq(products.source, 'off')
        : inArray(products.source, ['obf', 'off']);

  const rows = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      brand: products.brand,
      name: products.name,
      source: products.source,
    })
    .from(products)
    .where(and(isNull(products.imageFront), sourceCondition))
    .limit(limit ?? 100_000);

  console.log(
    `Found ${rows.length} product(s) with image_front IS NULL` +
      (source !== 'all' ? ` (source=${source})` : '') +
      (dry ? ' — DRY RUN' : '') +
      '.\n',
  );

  let filled = 0;
  let missed = 0;
  const viaCounts = { obf: 0, off: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = await fetchImageUrl(row.barcode);

    const tag = `[${i + 1}/${rows.length}]`;
    if (!result) {
      missed++;
      console.log(`${tag} MISS  ${row.barcode}  ${row.brand ?? '?'} — ${row.name}`);
    } else {
      filled++;
      viaCounts[result.via]++;
      console.log(`${tag} FILL  ${row.barcode}  via=${result.via}  ${row.brand ?? '?'} — ${row.name}`);

      if (!dry) {
        await db
          .update(products)
          .set({ imageFront: result.url, lastSyncedAt: new Date() })
          .where(eq(products.id, row.id));
      }
    }

    // Be polite to OFF/OBF. ~200ms between calls = ~5 req/s — well under
    // OBF's documented soft limit and predictable enough to estimate runs.
    await sleep(200);
  }

  console.log(
    `\nDone. Filled ${filled} (obf=${viaCounts.obf}, off=${viaCounts.off}), missed ${missed}.` +
      (dry ? '  (dry run — no rows updated)' : ''),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
