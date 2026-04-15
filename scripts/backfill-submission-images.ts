/**
 * Backfill image_front on products created from user submissions.
 *
 * When auto-publish or CLI publish created products before the image fix,
 * the front photo path wasn't carried over. This script looks up each
 * user-submitted product, finds the matching submission record, extracts
 * the front photo path, and updates the product row.
 *
 * Idempotent — skips products that already have an image_front value.
 *
 * Usage:
 *   npx tsx scripts/backfill-submission-images.ts          # apply updates
 *   npx tsx scripts/backfill-submission-images.ts --dry    # preview only
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') }); // overrides
config({ path: resolve(process.cwd(), '.env') });        // fallback

import { eq, and, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { products, userSubmissions } from '@/db/schema';

type PhotoEntry = { role: string; path: string };

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  // Find user-submitted products with no image
  const rows = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      name: products.name,
      sourceId: products.sourceId,
    })
    .from(products)
    .where(and(eq(products.source, 'user'), isNull(products.imageFront)));

  console.log(`Found ${rows.length} user-submitted product(s) missing image_front.\n`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    // sourceId stores the submissionId (passed as sourceId in upsertProduct)
    const submissionId = row.sourceId;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!submissionId || !uuidRe.test(submissionId)) {
      console.log(`  SKIP  ${row.barcode}  "${row.name}" — sourceId is not a UUID: ${submissionId}`);
      skipped++;
      continue;
    }

    const [submission] = await db
      .select({ photos: userSubmissions.photos })
      .from(userSubmissions)
      .where(eq(userSubmissions.id, submissionId))
      .limit(1);

    if (!submission) {
      console.log(`  SKIP  ${row.barcode}  "${row.name}" — submission ${submissionId} not found`);
      skipped++;
      continue;
    }

    const photos = submission.photos as PhotoEntry[];
    const frontPath = photos.find((p) => p.role === 'front')?.path;

    if (!frontPath) {
      console.log(`  SKIP  ${row.barcode}  "${row.name}" — no front photo in submission`);
      skipped++;
      continue;
    }

    if (dry) {
      console.log(`  WOULD UPDATE  ${row.barcode}  "${row.name}" → ${frontPath}`);
    } else {
      await db
        .update(products)
        .set({ imageFront: frontPath })
        .where(eq(products.id, row.id));
      console.log(`  UPDATED  ${row.barcode}  "${row.name}" → ${frontPath}`);
    }
    updated++;
  }

  console.log(
    `\nDone. ${dry ? 'Would update' : 'Updated'}: ${updated}, Skipped: ${skipped}`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
