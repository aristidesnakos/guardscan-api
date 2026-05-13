/**
 * Round-trip test for the translation claim flow (Phase 2).
 *
 * Verifies the durability contract for `upsertProduct` after the
 * 0008_translation_columns migration:
 *
 *   1. Fresh English row             → name written, no claim.
 *   2. Existing `original_name` set  → upstream name change ignored; our
 *                                       English name preserved.
 *   3. Existing status = 'manual'    → all claim fields untouched.
 *   4. Fresh foreign row + LLM       → translated (when API key present).
 *   5. Fresh foreign row + no LLM    → status='pending', original captured.
 *   6. looksForeign() heuristic      → spot checks incl. English allowlist.
 *
 * Writes a fixture barcode (90000000000XY) and cleans up at the end. Safe to
 * run against prod — never touches real catalog rows.
 *
 * Usage:
 *   npx tsx scripts/test-translation-claim.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envPath = resolve(__dirname, '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../db/client';
import { products, productIngredients } from '../db/schema';
import type { Product } from '../types/guardscan';
import { upsertProduct, resolveClaim } from '../lib/cron/ingest-helpers';
import { looksForeign, isTranslatorEnabled } from '../lib/translation';

// Fixture barcodes — 13 digits, all in the "9999" prefix block (private use)
const BARCODE_A = '9999900000001'; // fresh-English scenario
const BARCODE_B = '9999900000002'; // existing-claim scenario
const BARCODE_C = '9999900000003'; // manual-status scenario
const BARCODE_D = '9999900000004'; // fresh-foreign scenario

const FIXTURE_BARCODES = [BARCODE_A, BARCODE_B, BARCODE_C, BARCODE_D];

// ── Test harness ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ''}`);
    failed++;
    failures.push(label);
  }
}

function buildProduct(barcode: string, name: string, brand = 'Test Brand'): Product {
  const now = new Date().toISOString();
  return {
    id: `test:${barcode}`,
    barcode,
    name,
    brand,
    category: 'grooming',
    subcategory: 'body_wash',
    image_url: null,
    data_completeness: 'full',
    ingredient_source: 'open_food_facts',
    ingredients: [
      { name: 'aqua', position: 1, flag: 'neutral', reason: null },
    ],
    created_at: now,
    updated_at: now,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const barcode of FIXTURE_BARCODES) {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.barcode, barcode));
    for (const row of rows) {
      await db.delete(productIngredients).where(eq(productIngredients.productId, row.id));
      await db.delete(products).where(eq(products.id, row.id));
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testHeuristic(): Promise<void> {
  console.log('\n[looksForeign]');
  check('English passes', looksForeign('Body Wash Shower Gel') === false);
  check('French diacritic flags', looksForeign('Crème mani erboristica') === true);
  check('Italian token flags', looksForeign('Bagnoschiuma Doccia') === true);
  check('German token flags', looksForeign('Rasierschaum sensitive') === true);
  check('Maté allowlisted', looksForeign('Maté Energy Tea') === false);
  check('Naïve allowlisted', looksForeign('Naïve Sunscreen') === false);
  check('Acai allowlisted', looksForeign('Açaí Smoothie') === false);
  check('empty passes', looksForeign('') === false);
}

async function testFreshEnglish(): Promise<void> {
  console.log('\n[fresh English row]');
  const db = getDb();
  const product = buildProduct(BARCODE_A, 'Plain Body Wash');

  const id = await upsertProduct(db, product, 'obf', null, 'body_wash');
  check('upsert returned id', !!id);

  const [row] = await db.select().from(products).where(eq(products.barcode, BARCODE_A));
  check('name = incoming', row?.name === 'Plain Body Wash', `got "${row?.name}"`);
  check('original_name is null', row?.originalName === null);
  check('source_language is null', row?.sourceLanguage === null);
  check('translation_status is null', row?.translationStatus === null);
}

async function testExistingClaimPreserved(): Promise<void> {
  console.log('\n[existing original_name preserved]');
  const db = getDb();

  // Seed a translated row directly.
  await db.insert(products).values({
    barcode: BARCODE_B,
    name: 'Herbal Hand Cream',
    originalName: 'Crème mani erboristica',
    sourceLanguage: 'it',
    translationStatus: 'auto',
    brand: 'Test Brand',
    category: 'grooming',
    subcategory: 'hand_cream',
    source: 'obf',
    sourceId: BARCODE_B,
  });

  // Simulate OBF re-emit with the foreign name + a slightly different variant.
  const product = buildProduct(BARCODE_B, 'Crème mani erboristica DOPPIA');
  product.category = 'grooming';
  product.subcategory = 'hand_cream';
  await upsertProduct(db, product, 'obf', null, 'hand_cream');

  const [row] = await db.select().from(products).where(eq(products.barcode, BARCODE_B));
  check(
    'name preserved (English)',
    row?.name === 'Herbal Hand Cream',
    `got "${row?.name}"`,
  );
  check(
    'original_name refreshed with incoming',
    row?.originalName === 'Crème mani erboristica DOPPIA',
    `got "${row?.originalName}"`,
  );
  check('translation_status still auto', row?.translationStatus === 'auto');
  check('source_language still it', row?.sourceLanguage === 'it');
  check('upstream brand refreshed', row?.brand === 'Test Brand');
}

async function testManualSacred(): Promise<void> {
  console.log('\n[manual status sacred]');
  const db = getDb();

  await db.insert(products).values({
    barcode: BARCODE_C,
    name: 'Human-Curated Name',
    originalName: 'whatever-was-here',
    sourceLanguage: 'fr',
    translationStatus: 'manual',
    brand: 'Original Brand',
    category: 'grooming',
    subcategory: 'shampoo',
    source: 'obf',
    sourceId: BARCODE_C,
  });

  const product = buildProduct(BARCODE_C, 'Shampooing nutritif');
  product.brand = 'New Brand';
  await upsertProduct(db, product, 'obf', null, 'shampoo');

  const [row] = await db.select().from(products).where(eq(products.barcode, BARCODE_C));
  check('name untouched', row?.name === 'Human-Curated Name', `got "${row?.name}"`);
  check(
    'original_name untouched',
    row?.originalName === 'whatever-was-here',
    `got "${row?.originalName}"`,
  );
  check('translation_status still manual', row?.translationStatus === 'manual');
  check('source_language preserved', row?.sourceLanguage === 'fr');
  // Upstream fields DO refresh on manual rows — claim only protects naming.
  check('brand refreshed', row?.brand === 'New Brand', `got "${row?.brand}"`);
}

async function testResolveClaimPure(): Promise<void> {
  console.log('\n[resolveClaim pure paths]');
  const baseProduct = buildProduct('test', 'Plain English Body Wash');

  const r1 = await resolveClaim(baseProduct, null);
  check('null existing + English → no claim', r1.translationStatus === null && r1.originalName === null);

  const r2 = await resolveClaim(baseProduct, {
    name: 'Custom',
    originalName: 'orig',
    sourceLanguage: 'fr',
    translationStatus: 'manual',
  });
  check('manual → name preserved', r2.name === 'Custom' && r2.translationStatus === 'manual');

  const r3 = await resolveClaim(buildProduct('test', 'Crème mani DOPPIA'), {
    name: 'Herbal Hand Cream',
    originalName: 'Crème mani',
    sourceLanguage: 'it',
    translationStatus: 'auto',
  });
  check(
    'auto + new incoming → name kept, original refreshed',
    r3.name === 'Herbal Hand Cream' && r3.originalName === 'Crème mani DOPPIA',
  );
}

async function testFreshForeign(): Promise<void> {
  console.log('\n[fresh foreign row]');
  const db = getDb();
  const product = buildProduct(BARCODE_D, 'Bagnoschiuma Doccia');

  await upsertProduct(db, product, 'obf', null, 'body_wash');
  const [row] = await db.select().from(products).where(eq(products.barcode, BARCODE_D));

  if (isTranslatorEnabled()) {
    // LLM should have run — either translated successfully (status=auto) or
    // failed (status=failed). Either way, original_name captured.
    check(
      'translation_status is auto|failed|pending',
      row?.translationStatus === 'auto' ||
        row?.translationStatus === 'failed' ||
        row?.translationStatus === 'pending',
      `got "${row?.translationStatus}"`,
    );
    check('original_name captured', row?.originalName === 'Bagnoschiuma Doccia');
    if (row?.translationStatus === 'auto') {
      check('translated name differs from source', row?.name !== 'Bagnoschiuma Doccia');
      check('source_language set', !!row?.sourceLanguage);
      console.log(`    translated: "${row?.name}" (lang=${row?.sourceLanguage})`);
    }
  } else {
    // No LLM — should mark pending for outbox/backfill.
    check('translation_status = pending', row?.translationStatus === 'pending');
    check('original_name captured', row?.originalName === 'Bagnoschiuma Doccia');
    check('name stays as foreign original', row?.name === 'Bagnoschiuma Doccia');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══ Translation claim round-trip test ═══');
  console.log(`  translator: ${isTranslatorEnabled() ? 'enabled' : 'disabled'}`);

  await cleanup(); // start clean
  try {
    await testHeuristic();
    await testResolveClaimPure();
    await testFreshEnglish();
    await testExistingClaimPreserved();
    await testManualSacred();
    await testFreshForeign();
  } finally {
    await cleanup();
    await closeDb();
  }

  console.log('');
  console.log(`═══ ${passed} passed, ${failed} failed ═══`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
