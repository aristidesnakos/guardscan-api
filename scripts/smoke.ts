/**
 * M1 smoke test.
 *
 * Hits the scan route against a known-good OFF barcode (Nutella 750g,
 * `3017620422003`) and asserts the response matches the expected `ScanResult`
 * shape. Used in CI and as a quick local sanity check.
 *
 * Run:
 *   npm run smoke                       # uses http://localhost:3000 by default
 *   API_URL=https://... npm run smoke   # point at a deployed preview
 *
 * Exits non-zero on any failure so it can be wired into a CI step.
 */

import type { ScanResult } from '../types/guardscan';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const BARCODE = '3017620422003'; // Nutella 750g

// Auth: pass X-Dev-User-Id when ALLOW_DEV_AUTH=true (local dev),
// or a real Bearer token via SMOKE_AUTH_TOKEN (CI / staging).
const authHeaders: Record<string, string> = {};
if (process.env.SMOKE_DEV_USER_ID) {
  authHeaders['X-Dev-User-Id'] = process.env.SMOKE_DEV_USER_ID;
} else if (process.env.SMOKE_AUTH_TOKEN) {
  authHeaders['Authorization'] = `Bearer ${process.env.SMOKE_AUTH_TOKEN}`;
}

type Assertion = { name: string; ok: boolean; detail?: string };

function assert(name: string, condition: boolean, detail?: string): Assertion {
  return { name, ok: condition, detail };
}

async function main() {
  console.log(`[smoke] GET ${API_URL}/api/products/scan/${BARCODE}`);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/products/scan/${BARCODE}`, {
      headers: { Accept: 'application/json', ...authHeaders },
    });
  } catch (err) {
    console.error(`[smoke] fetch failed: ${err}`);
    console.error(
      `[smoke] hint: is the dev server running? (npm run dev in another terminal)`,
    );
    process.exit(1);
  }

  const durationMs = Date.now() - started;
  console.log(`[smoke] HTTP ${response.status} in ${durationMs}ms`);

  if (!response.ok) {
    const body = await response.text();
    console.error(`[smoke] non-200 body: ${body}`);
    process.exit(1);
  }

  const result = (await response.json()) as ScanResult;

  const assertions: Assertion[] = [
    assert('has product', Boolean(result.product)),
    assert('barcode matches', result.product?.barcode === BARCODE, result.product?.barcode),
    assert('has product name', Boolean(result.product?.name), result.product?.name),
    assert('category is food', result.product?.category === 'food', result.product?.category),
    assert(
      'ingredient_source is open_food_facts',
      result.product?.ingredient_source === 'open_food_facts',
      result.product?.ingredient_source,
    ),
    assert(
      'has image url',
      Boolean(result.product?.image_url),
      result.product?.image_url ?? '(null)',
    ),
    assert(
      'has ingredients',
      (result.product?.ingredients?.length ?? 0) > 0,
      `count=${result.product?.ingredients?.length ?? 0}`,
    ),
    assert('has score', result.score !== null, JSON.stringify(result.score?.overall_score)),
    assert(
      'score in [0,100]',
      result.score !== null &&
        result.score.overall_score >= 0 &&
        result.score.overall_score <= 100,
      `${result.score?.overall_score}`,
    ),
    // M1.5: dictionary + Nutri-Score dimension should push Nutella below Excellent.
    // Nutella has Nutri-Score E (raw 31) → nutritional quality ~16/100 → weighted
    // overall should be Mediocre or Poor (< 60), certainly not Excellent (< 80).
    assert(
      'Nutella not rated Excellent (dictionary + Nutri-Score working)',
      result.score !== null && result.score.overall_score < 80,
      `${result.score?.overall_score} / ${result.score?.rating}`,
    ),
    assert(
      'has flagged ingredients (dictionary lookup working)',
      (result.score?.flagged_ingredients?.length ?? 0) > 0,
      `count=${result.score?.flagged_ingredients?.length ?? 0}`,
    ),
    assert(
      'has multiple scoring dimensions (Nutri-Score dimension present)',
      (result.score?.dimensions?.length ?? 0) >= 2,
      `count=${result.score?.dimensions?.length ?? 0}`,
    ),
    assert('supplement_quality is null', result.supplement_quality === null),
    assert('alternatives is array', Array.isArray(result.alternatives)),
  ];

  let failed = 0;
  for (const a of assertions) {
    const marker = a.ok ? '  ok' : 'FAIL';
    const detail = a.detail ? ` (${a.detail})` : '';
    console.log(`[smoke] ${marker}  ${a.name}${detail}`);
    if (!a.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`[smoke] ${failed}/${assertions.length} assertions failed`);
    process.exit(1);
  }

  console.log(`[smoke] all ${assertions.length} assertions passed`);
  console.log(
    `[smoke] product: ${result.product.name} (${result.product.brand || 'unknown brand'}) → score ${result.score?.overall_score} / ${result.score?.rating}`,
  );
}

main().catch((err) => {
  console.error('[smoke] unexpected error:', err);
  process.exit(1);
});
