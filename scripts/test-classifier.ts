/**
 * Smoke test for the subcategory classifier.
 *
 * Runs a fixed list of 20 real product names through the hybrid classifier
 * and prints which layer resolved each (keyword or LLM) plus the answer.
 * Use this to:
 *   - sanity-check the LLM output after tweaking the prompt or model
 *   - confirm OPENROUTER_API_KEY + OPENROUTER_CLASSIFIER_MODEL are wired
 *   - eyeball determinism (run twice, compare)
 *
 * Does NOT touch the database. Exits 0 regardless of results — failures
 * show up as null entries in the output table.
 *
 * Usage:
 *   npx tsx scripts/test-classifier.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envPath = resolve(__dirname, '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

import type { ProductCategory } from '../types/guardscan';
import { inferSubcategory } from '../lib/subcategory';
import {
  classifySubcategoryWithLlm,
  isLlmClassifierEnabled,
} from '../lib/llm/classifier';

type Fixture = {
  name: string;
  category: ProductCategory;
  /** The subcategory we'd like to see. Null = anything non-garbage is ok. */
  expect?: string | null;
};

const FIXTURES: Fixture[] = [
  // Obvious keyword hits — should never reach the LLM.
  { name: 'Old Spice High Endurance Deodorant', category: 'grooming', expect: 'deodorant' },
  { name: 'Dove Men+Care Body Wash', category: 'grooming', expect: 'body_wash' },
  { name: 'Dr. Squatch Bar Soap', category: 'grooming', expect: 'soap' },
  { name: 'Cremo Shave Cream', category: 'grooming', expect: 'shave' },
  { name: 'Jack Black Beard Oil', category: 'grooming', expect: 'beard' },
  { name: 'Neutrogena Sunscreen SPF 50', category: 'grooming', expect: 'sunscreen' },
  { name: 'Optimum Nutrition Gold Standard Whey', category: 'supplement', expect: 'protein' },
  { name: 'Nordic Naturals Ultimate Omega', category: 'supplement', expect: 'omega' },
  { name: 'Centrum Men Multivitamin', category: 'supplement', expect: 'multivitamin' },
  { name: 'Nature Made Fish Oil 1200 mg', category: 'supplement', expect: 'omega' },

  // Previously broken — keyword fix should now return null (LLM handles).
  { name: 'Nivea Men Fresh Active Antiperspirant', category: 'grooming', expect: 'deodorant' },
  { name: 'Nivea Men Energy Fresh', category: 'grooming', expect: 'deodorant' },
  { name: 'Wood Barrel Bourbon Bar Soap', category: 'grooming', expect: 'soap' },

  // Keyword-null cases — these should exercise the LLM fallback.
  { name: 'Duke Cannon Big Ass Brick of Soap', category: 'grooming', expect: 'soap' },
  { name: 'Every Man Jack Citrus Scrub', category: 'grooming', expect: 'cleanser' },
  { name: 'Harrys Foaming Shave Gel', category: 'grooming', expect: 'shave' },
  { name: 'Thorne Basic Nutrients 2/Day', category: 'supplement', expect: 'multivitamin' },
  { name: 'Ghost Legend Pre-Workout', category: 'supplement', expect: 'pre_workout' },

  // Edge case: garbage/untypeable — LLM should return null or something plausible.
  { name: 'Mystery Product XYZ', category: 'grooming' },
  { name: 'Sample Kit Variety Pack', category: 'grooming' },
];

async function main() {
  console.log(`Classifier smoke test (${FIXTURES.length} fixtures)`);
  console.log(`  llm: ${isLlmClassifierEnabled() ? 'enabled' : 'disabled (no OPENROUTER_API_KEY)'}`);
  console.log(`  model: ${process.env.OPENROUTER_CLASSIFIER_MODEL ?? 'qwen/qwen3.5-9b (default)'}`);
  console.log('');

  let hits = 0;
  let misses = 0;
  let llmCalls = 0;

  for (const fx of FIXTURES) {
    const keyword = inferSubcategory(fx.name, fx.category);
    let llm: string | null = null;
    let answer: string | null = keyword;
    let via: 'keyword' | 'llm' | 'none' = keyword ? 'keyword' : 'none';

    if (!keyword && isLlmClassifierEnabled()) {
      llm = await classifySubcategoryWithLlm(fx.name, fx.category);
      answer = llm;
      via = llm ? 'llm' : 'none';
      llmCalls++;
    }

    const expectStr = fx.expect ?? '(any)';
    const match =
      fx.expect === undefined
        ? true
        : fx.expect === answer;
    if (match) hits++;
    else misses++;

    const marker = match ? 'OK ' : 'FAIL';
    const tag = `[${via}]`.padEnd(10);
    console.log(
      `  ${marker} ${tag} ${(answer ?? '∅').padEnd(14)} want=${expectStr.padEnd(14)} ${fx.name}`,
    );
  }

  console.log('');
  console.log(`Results: ${hits}/${FIXTURES.length} matched expectations (${misses} mismatches)`);
  console.log(`LLM calls made: ${llmCalls}`);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
