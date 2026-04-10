/**
 * Admin CLI for reviewing and publishing user-submitted products.
 *
 * Usage:
 *   npm run admin:submissions list            # list pending submissions
 *   npm run admin:submissions review <id>     # interactive review + publish
 *   npm run admin:submissions reject <id> <reason>
 */

import { asc, eq } from 'drizzle-orm';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

import { getDb } from '@/db/client';
import { userSubmissions, products } from '@/db/schema';
import { signedSubmissionUrl } from '@/lib/storage/supabase';
import { lookupIngredient } from '@/lib/dictionary/lookup';
import { scoreProduct } from '@/lib/scoring';
import type { Product, ProductCategory } from '@/types/guardscan';
import { upsertProduct } from '@/lib/cron/ingest-helpers';

// ── list ─────────────────────────────────────────────────────────────────────

async function listPending() {
  const db = getDb();
  const rows = await db
    .select()
    .from(userSubmissions)
    .where(eq(userSubmissions.status, 'pending'))
    .orderBy(asc(userSubmissions.createdAt));

  console.log(`\n${rows.length} pending submission(s):\n`);
  for (const row of rows) {
    const ocr = row.ocrText ? (JSON.parse(row.ocrText) as { confidence?: number }) : null;
    const confidence = ocr?.confidence != null ? ` (confidence: ${ocr.confidence})` : ' (OCR pending)';
    console.log(`  ${row.id}  barcode=${row.barcode}  ${row.createdAt.toISOString()}${confidence}`);
  }
}

// ── review ────────────────────────────────────────────────────────────────────

async function reviewOne(submissionId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userSubmissions)
    .where(eq(userSubmissions.id, submissionId))
    .limit(1);

  if (!row) {
    console.error('Submission not found:', submissionId);
    process.exit(1);
  }

  if (row.status !== 'pending' && row.status !== 'in_review') {
    console.error(`Submission is already ${row.status}. Nothing to do.`);
    process.exit(1);
  }

  // Mark as in_review while we work
  await db
    .update(userSubmissions)
    .set({ status: 'in_review' })
    .where(eq(userSubmissions.id, submissionId));

  type PhotoEntry = { role: string; path: string };
  const photos = row.photos as PhotoEntry[];
  const [frontUrl, backUrl] = await Promise.all([
    signedSubmissionUrl(photos.find((p) => p.role === 'front')!.path),
    signedSubmissionUrl(photos.find((p) => p.role === 'back')!.path),
  ]);

  const ocr = row.ocrText
    ? (JSON.parse(row.ocrText) as {
        name: string | null;
        brand: string | null;
        category: string | null;
        ingredients: string[];
        confidence: number;
        notes: string[];
      })
    : null;

  console.log('\n─── Submission ──────────────────────────────');
  console.log(`ID:       ${row.id}`);
  console.log(`Barcode:  ${row.barcode}`);
  console.log(`Front:    ${frontUrl}`);
  console.log(`Back:     ${backUrl}`);
  console.log('\n─── Claude pre-fill ─────────────────────────');

  if (!ocr) {
    console.log('(OCR not yet complete — wait a moment and retry)');
    await db
      .update(userSubmissions)
      .set({ status: 'pending' })
      .where(eq(userSubmissions.id, submissionId));
    return;
  }

  console.log(`Confidence: ${ocr.confidence}`);
  console.log(`Name:       ${ocr.name ?? '(none)'}`);
  console.log(`Brand:      ${ocr.brand ?? '(none)'}`);
  console.log(`Category:   ${ocr.category ?? '(none)'}`);
  console.log(`Ingredients (${ocr.ingredients.length}):`);
  ocr.ingredients.forEach((ing, i) => console.log(`  ${i + 1}. ${ing}`));
  if (ocr.notes.length) console.log(`Notes: ${ocr.notes.join('; ')}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const name = (await rl.question(`\nName [${ocr.name ?? ''}]: `)) || ocr.name;
  const brand = (await rl.question(`Brand [${ocr.brand ?? ''}]: `)) || ocr.brand;
  const category =
    (await rl.question(`Category (food/grooming/supplement) [${ocr.category ?? ''}]: `)) ||
    ocr.category;
  const ingredientsInput = await rl.question(
    `Ingredients (comma-separated, blank to keep): `,
  );
  const ingredients: string[] = ingredientsInput
    ? ingredientsInput.split(',').map((s) => s.trim()).filter(Boolean)
    : ocr.ingredients;

  if (!name || !category || !['food', 'grooming', 'supplement'].includes(category)) {
    console.log('\nAborted: name and a valid category are required.');
    rl.close();
    await db
      .update(userSubmissions)
      .set({ status: 'pending' })
      .where(eq(userSubmissions.id, submissionId));
    return;
  }

  // Preview scored ingredients
  console.log('\n─── Ingredient lookup preview ───────────────');
  const resolvedIngredients = ingredients.map((ingName, i) => {
    const normalized = ingName.toLowerCase().trim();
    const entry = lookupIngredient(normalized);
    const flag = entry?.flag ?? 'neutral';
    console.log(`  ${i + 1}. ${ingName} → ${flag}`);
    return {
      name: ingName,
      position: i + 1,
      flag: flag as 'positive' | 'neutral' | 'caution' | 'negative',
      reason: entry?.reason ?? '',
      fertility_relevant: entry?.fertility_relevant ?? false,
      testosterone_relevant: entry?.testosterone_relevant ?? false,
    };
  });

  const confirm = await rl.question('\nPublish? (y/N): ');
  rl.close();

  if (confirm.toLowerCase() !== 'y') {
    console.log('Aborted.');
    await db
      .update(userSubmissions)
      .set({ status: 'pending' })
      .where(eq(userSubmissions.id, submissionId));
    return;
  }

  // Build canonical Product and score it
  const now = new Date().toISOString();
  const product: Product = {
    id: randomUUID(),
    barcode: row.barcode,
    name,
    brand: brand ?? '',
    category: category as ProductCategory,
    subcategory: null,
    image_url: null,
    data_completeness: 'full',
    ingredient_source: 'user_contributed',
    ingredients: resolvedIngredients,
    created_at: now,
    updated_at: now,
  };

  const score = scoreProduct({ product });

  const productId = await upsertProduct(db, product, 'user', score, null, submissionId);

  if (!productId) {
    console.error('\nFailed to publish product. Check logs.');
    await db
      .update(userSubmissions)
      .set({ status: 'pending' })
      .where(eq(userSubmissions.id, submissionId));
    return;
  }

  await db
    .update(userSubmissions)
    .set({
      status: 'published',
      reviewedBy: process.env.ADMIN_USER_IDS?.split(',')[0]?.trim() ?? 'cli',
    })
    .where(eq(userSubmissions.id, submissionId));

  console.log(`\n✓ Published  product_id=${productId}  score=${score?.overall_score ?? 'null'}`);
}

// ── reject ────────────────────────────────────────────────────────────────────

async function rejectOne(submissionId: string, reason: string) {
  const db = getDb();
  const [row] = await db
    .select({ id: userSubmissions.id, status: userSubmissions.status })
    .from(userSubmissions)
    .where(eq(userSubmissions.id, submissionId))
    .limit(1);

  if (!row) {
    console.error('Submission not found:', submissionId);
    process.exit(1);
  }
  if (row.status === 'published') {
    console.error('Cannot reject a published submission. Use unpublish instead.');
    process.exit(1);
  }

  await db
    .update(userSubmissions)
    .set({ status: 'rejected' })
    .where(eq(userSubmissions.id, submissionId));

  console.log(`✓ Rejected  ${submissionId}  reason="${reason}"`);
}

// ── entry point ───────────────────────────────────────────────────────────────

const [cmd, arg, ...rest] = process.argv.slice(2);

if (cmd === 'list' || !cmd) {
  await listPending();
} else if (cmd === 'review' && arg) {
  await reviewOne(arg);
} else if (cmd === 'reject' && arg && rest[0]) {
  await rejectOne(arg, rest.join(' '));
} else {
  console.log(
    'Usage:\n' +
      '  admin-submissions list\n' +
      '  admin-submissions review <id>\n' +
      '  admin-submissions reject <id> <reason>',
  );
  process.exit(1);
}
