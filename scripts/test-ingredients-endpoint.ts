/**
 * Quick end-to-end test for GET /api/ingredients/:normalized
 *
 * Usage:
 *   npm run dev  # in one terminal
 *   AUTH_ENABLED=false npx tsx scripts/test-ingredients-endpoint.ts  # in another
 *
 * Tests:
 * - Valid ingredient with tags (negative/caution)
 * - Valid ingredient without tags (positive/neutral)
 * - Alias lookup
 * - 404 for unknown ingredient
 * - Response shape validation
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3003';

interface IngredientDetail {
  normalized: string;
  display_name: string;
  ingredient_group: string;
  health_risk_tags: string[];
  description: string | null;
  evidence_url: string;
}

async function testEndpoint(
  normalized: string,
  expectStatus: number = 200,
  description: string = '',
) {
  const encoded = encodeURIComponent(normalized);
  const url = `${BASE_URL}/api/ingredients/${encoded}`;

  try {
    const res = await fetch(url);
    const data = (await res.json()) as unknown;

    const statusOk = res.status === expectStatus;
    const statusIcon = statusOk ? '✅' : '❌';

    console.log(`\n${statusIcon} ${description}`);
    console.log(`   GET ${url}`);
    console.log(`   Status: ${res.status} (expected ${expectStatus})`);

    if (expectStatus === 200 && res.status === 200) {
      const detail = data as IngredientDetail;
      console.log(`   ✓ normalized: ${detail.normalized}`);
      console.log(`   ✓ ingredient_group: ${detail.ingredient_group}`);
      console.log(`   ✓ health_risk_tags: ${JSON.stringify(detail.health_risk_tags)}`);
      console.log(`   ✓ display_name: ${detail.display_name}`);
      console.log(`   ✓ description: ${detail.description ?? '(null — Phase 3)'}`);

      // Validate shape
      if (
        typeof detail.normalized !== 'string' ||
        typeof detail.display_name !== 'string' ||
        typeof detail.ingredient_group !== 'string' ||
        !Array.isArray(detail.health_risk_tags) ||
        (detail.description !== null && typeof detail.description !== 'string') ||
        typeof detail.evidence_url !== 'string'
      ) {
        console.log(`   ❌ INVALID RESPONSE SHAPE`);
        return false;
      }
    } else if (res.status === 404) {
      const error = data as { error: string };
      console.log(`   ✓ error: ${error.error}`);
    }

    return statusOk;
  } catch (err) {
    console.log(
      `\n❌ ${description}\n   Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function main() {
  console.log(`🧪 Testing GET /api/ingredients/:normalized`);
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   (Make sure \`npm run dev\` is running)\n`);

  const results: boolean[] = [];

  // Test 1: Negative ingredient with tags
  results.push(
    await testEndpoint(
      'sodium lauryl sulfate',
      200,
      'Negative ingredient (SLS) — should have irritant tag',
    ),
  );

  // Test 2: Caution ingredient with endocrine tag
  results.push(
    await testEndpoint(
      'fragrance',
      200,
      'Caution ingredient (fragrance) — should have allergen + endocrine_disruptor tags',
    ),
  );

  // Test 3: Positive ingredient (no tags)
  results.push(
    await testEndpoint(
      'zinc',
      200,
      'Positive ingredient (zinc) — should have empty health_risk_tags',
    ),
  );

  // Test 4: Alias lookup
  results.push(
    await testEndpoint(
      'sls',
      200,
      'Alias lookup (sls → sodium lauryl sulfate) — should resolve',
    ),
  );

  // Test 5: Case-insensitive
  results.push(
    await testEndpoint(
      'ASHWAGANDHA',
      200,
      'Case-insensitive (ASHWAGANDHA) — should lowercase and resolve',
    ),
  );

  // Test 6: Unknown ingredient (404)
  results.push(
    await testEndpoint(
      'xyzzy-not-a-real-ingredient',
      404,
      'Unknown ingredient — should return 404',
    ),
  );

  // Summary
  const passed = results.filter((r) => r).length;
  const total = results.length;
  const allPass = passed === total;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Result: ${passed}/${total} tests passed ${allPass ? '✅' : '❌'}`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(allPass ? 0 : 1);
}

main();
