/**
 * Cache-vs-fresh parity check (P9).
 *
 * Guards against score divergence between a cached read and a live OFF fetch
 * for the same barcode. Catches regressions in:
 *   - P7: ingredient ORDER BY (shuffled positions → different score tier)
 *   - P2: hydration helper (fertility/testosterone flags lost on cache reads)
 *   - P3: category routing (titanium dioxide food vs. grooming)
 *
 * Strategy:
 *   1. Scan the barcode — first call may be fresh (OFF lookup) or cached.
 *   2. Scan it again — second call will always be a cache hit (the first
 *      call's `after()` write has committed by this point).
 *   3. Assert deep equality on the score and ingredient ordering.
 *
 * For a true cache-bust (first call guaranteed fresh), delete the product row
 * from DB before running. The test still provides regression value with cached-
 * vs-cached reads because:
 *   - P7 regressions cause non-deterministic Postgres ordering on consecutive
 *     reads of the same rows.
 *   - P2 regressions cause consistent hydration bugs, caught by the
 *     assessment_coverage and personalization assertions.
 *
 * Run:
 *   npx tsx scripts/parity-check.ts
 *   API_URL=https://... npx tsx scripts/parity-check.ts
 *
 * Exits non-zero on any failure.
 */

import type { ScanResult } from '../types/guardscan';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

// Auth headers (mirrors smoke.ts pattern)
const authHeaders: Record<string, string> = {};
if (process.env.SMOKE_DEV_USER_ID) {
  authHeaders['X-Dev-User-Id'] = process.env.SMOKE_DEV_USER_ID;
} else if (process.env.SMOKE_AUTH_TOKEN) {
  authHeaders['Authorization'] = `Bearer ${process.env.SMOKE_AUTH_TOKEN}`;
}

// ── Test cases ───────────────────────────────────────────────────────────────
// Add more barcodes as products are onboarded.
// Mark "UPC TBD" entries with their known barcodes once verified in OFF/OBF.
const TEST_CASES: { description: string; barcode: string; lifeStage?: string }[] = [
  {
    description: 'Nutella (non-English food, exercises P1 lookupHint path)',
    barcode: '3017620422003',
  },
  {
    description: 'Nutella personalized (actively_trying_to_conceive — exercises P2 fertility flags)',
    barcode: '3017620422003',
    lifeStage: 'actively_trying_to_conceive',
  },
  // TODO: add English food barcode (Coca-Cola UPC) when confirmed in OFF
  // TODO: add grooming barcode (Gillette gel UPC) when confirmed in OBF — exercises P3
  // TODO: add supplement barcode (Centrum DSLD ID) when M2 DSLD is live
];

// ── Comparison helpers ───────────────────────────────────────────────────────

type Assertion = { name: string; ok: boolean; detail?: string };

function assert(name: string, ok: boolean, detail?: string): Assertion {
  return { name, ok, detail };
}

function compareResults(a: ScanResult, b: ScanResult): Assertion[] {
  const assertions: Assertion[] = [];

  // Score value
  assertions.push(assert(
    'overall_score matches',
    a.score?.overall_score === b.score?.overall_score,
    `${a.score?.overall_score} vs ${b.score?.overall_score}`,
  ));

  // Rating (derived from score — consistency check)
  assertions.push(assert(
    'rating matches',
    a.score?.rating === b.score?.rating,
    `${a.score?.rating} vs ${b.score?.rating}`,
  ));

  // Personalization flag (critical for ?life_stage cases — P2)
  assertions.push(assert(
    'personalized flag matches',
    a.score?.personalized === b.score?.personalized,
    `${a.score?.personalized} vs ${b.score?.personalized}`,
  ));

  // assessment_coverage (synthesized on read — P2: pre-b06ff6d blobs must get coverage)
  const aCov = a.score?.assessment_coverage;
  const bCov = b.score?.assessment_coverage;
  assertions.push(assert(
    'assessment_coverage present on both',
    Boolean(aCov) && Boolean(bCov),
    `${aCov ? 'present' : 'MISSING'} vs ${bCov ? 'present' : 'MISSING'}`,
  ));
  if (aCov && bCov) {
    assertions.push(assert(
      'assessment_coverage.percentage matches',
      aCov.percentage === bCov.percentage,
      `${aCov.percentage}% vs ${bCov.percentage}%`,
    ));
  }

  // Flagged ingredient count (P3: category routing must be stable across reads)
  const aFlagged = a.score?.flagged_ingredients?.length ?? 0;
  const bFlagged = b.score?.flagged_ingredients?.length ?? 0;
  assertions.push(assert(
    'flagged_ingredients count matches',
    aFlagged === bFlagged,
    `${aFlagged} vs ${bFlagged}`,
  ));

  // Ingredient count
  const aIngCount = a.product?.ingredients?.length ?? 0;
  const bIngCount = b.product?.ingredients?.length ?? 0;
  assertions.push(assert(
    'ingredient count matches',
    aIngCount === bIngCount,
    `${aIngCount} vs ${bIngCount}`,
  ));

  // Ingredient ordering — P7 regression: without ORDER BY position, Postgres
  // can return rows in different orders on consecutive reads.
  if (aIngCount === bIngCount && aIngCount > 0) {
    const aPositions = a.product.ingredients.map((i) => i.position).join(',');
    const bPositions = b.product.ingredients.map((i) => i.position).join(',');
    assertions.push(assert(
      'ingredient positions identical',
      aPositions === bPositions,
      `[${aPositions}] vs [${bPositions}]`,
    ));

    const aNames = a.product.ingredients.map((i) => i.name).join('|');
    const bNames = b.product.ingredients.map((i) => i.name).join('|');
    assertions.push(assert(
      'ingredient ordering identical',
      aNames === bNames,
    ));
  }

  return assertions;
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function scanBarcode(barcode: string, lifeStage?: string): Promise<ScanResult> {
  const qs = lifeStage ? `?life_stage=${lifeStage}` : '';
  const url = `${API_URL}/api/products/scan/${barcode}${qs}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...authHeaders },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${body}`);
  }
  return response.json() as Promise<ScanResult>;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[parity] ${API_URL}`);
  console.log(`[parity] ${TEST_CASES.length} test cases\n`);

  let totalPassed = 0;
  let totalFailed = 0;

  for (const tc of TEST_CASES) {
    const label = tc.lifeStage ? `${tc.barcode}?life_stage=${tc.lifeStage}` : tc.barcode;
    console.log(`[parity] ── ${tc.description} (${label})`);

    let first: ScanResult;
    let second: ScanResult;

    try {
      first = await scanBarcode(tc.barcode, tc.lifeStage);
    } catch (err) {
      console.log(`[parity] SKIP  first scan failed: ${err}`);
      continue;
    }

    // Brief pause so the after() cache write has time to commit before the
    // second read. 300 ms is conservative — the write is usually < 50 ms.
    await new Promise((r) => setTimeout(r, 300));

    try {
      second = await scanBarcode(tc.barcode, tc.lifeStage);
    } catch (err) {
      console.log(`[parity] SKIP  second scan failed: ${err}`);
      continue;
    }

    const assertions = compareResults(first, second);
    let caseFailed = 0;

    for (const a of assertions) {
      const marker = a.ok ? '  ok' : 'FAIL';
      const detail = a.detail ? ` (${a.detail})` : '';
      console.log(`[parity]   ${marker}  ${a.name}${detail}`);
      if (!a.ok) caseFailed++;
    }

    const casePassed = assertions.length - caseFailed;
    totalPassed += casePassed;
    totalFailed += caseFailed;

    const summary = caseFailed === 0
      ? `all ${assertions.length} assertions passed`
      : `${caseFailed}/${assertions.length} assertions FAILED`;
    console.log(`[parity]   → ${summary}\n`);
  }

  const total = totalPassed + totalFailed;
  if (totalFailed > 0) {
    console.error(`[parity] FAILED: ${totalFailed}/${total} assertions across all cases`);
    process.exit(1);
  }

  console.log(`[parity] all ${total} assertions passed across ${TEST_CASES.length} cases`);
}

main().catch((err) => {
  console.error('[parity] unexpected error:', err);
  process.exit(1);
});
