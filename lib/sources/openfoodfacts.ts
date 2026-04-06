/**
 * Open Food Facts v2 adapter.
 *
 * Docs: https://openfoodfacts.github.io/openfoodfacts-server/api/
 * Licence: ODbL — attribution required in the app's About screen.
 *
 * This module owns:
 *   - Fetching a single barcode from OFF with a required User-Agent header.
 *   - Validating the response shape via zod (the API has long-tail drift).
 *   - Returning a typed `OffProduct | null`. `null` = 404 (product not in OFF).
 *
 * Normalization to the canonical `Product` type lives in `lib/normalize.ts`.
 */

import { z } from 'zod';

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * We deliberately only pick fields we use. OFF returns thousands of keys and
 * will add more over time; `passthrough()` at the product level keeps us
 * forward-compatible without destroying validation on the known fields.
 */
const ingredientSchema = z
  .object({
    id: z.string().optional(),
    text: z.string().optional(),
    rank: z.number().optional(),
    vegan: z.string().optional(),
    vegetarian: z.string().optional(),
  })
  .passthrough();

const offProductSchema = z
  .object({
    code: z.string().optional(),
    product_name: z.string().optional(),
    product_name_en: z.string().optional(),
    brands: z.string().optional(),
    image_front_url: z.string().url().optional(),
    image_ingredients_url: z.string().url().optional(),
    image_nutrition_url: z.string().url().optional(),
    ingredients_text: z.string().optional(),
    ingredients_text_en: z.string().optional(),
    ingredients: z.array(ingredientSchema).optional(),
    categories: z.string().optional(),
    categories_tags: z.array(z.string()).optional(),
    nutriscore_score: z.number().optional(),
    nutrition_grades: z.string().optional(),
  })
  .passthrough();

const offResponseSchema = z.object({
  status: z.number(), // 0 = not found, 1 = found
  code: z.string().optional(),
  product: offProductSchema.optional(),
});

export type OffProduct = z.infer<typeof offProductSchema>;

// ── Fetcher ─────────────────────────────────────────────────────────────────

const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product';

export class OffFetchError extends Error {
  constructor(
    message: string,
    public readonly barcode: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OffFetchError';
  }
}

/**
 * Fetches a single product from OFF by barcode.
 *
 * @returns the parsed product, or `null` if OFF reports status=0 (not found).
 * @throws `OffFetchError` on network failure, non-200, or schema validation failure.
 */
export async function fetchOffProduct(barcode: string): Promise<OffProduct | null> {
  const userAgent = process.env.OFF_USER_AGENT;
  if (!userAgent) {
    throw new OffFetchError(
      'OFF_USER_AGENT env var is required by Open Food Facts. ' +
        'Set it to e.g. "GuardScan/1.0 (contact@example.com)".',
      barcode,
    );
  }

  // OFF v2 supports `fields=` to trim the payload. We request only what we need
  // — keeps the response under ~5KB for most products instead of ~100KB.
  const fields = [
    'code',
    'product_name',
    'product_name_en',
    'brands',
    'image_front_url',
    'image_ingredients_url',
    'image_nutrition_url',
    'ingredients_text',
    'ingredients_text_en',
    'ingredients',
    'categories',
    'categories_tags',
    'nutriscore_score',
    'nutrition_grades',
  ].join(',');

  const url = `${OFF_BASE}/${encodeURIComponent(barcode)}?fields=${fields}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
      // OFF has no hard SLA; fall back quickly on cold starts.
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new OffFetchError(`Network error calling OFF for ${barcode}`, barcode, err);
  }

  if (!response.ok) {
    // OFF returns 404 for never-seen barcodes; everything else is a real error.
    if (response.status === 404) return null;
    throw new OffFetchError(
      `OFF returned HTTP ${response.status} for ${barcode}`,
      barcode,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new OffFetchError(`OFF returned invalid JSON for ${barcode}`, barcode, err);
  }

  const parsed = offResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OffFetchError(
      `OFF response failed schema validation for ${barcode}: ${parsed.error.message}`,
      barcode,
      parsed.error,
    );
  }

  if (parsed.data.status === 0 || !parsed.data.product) {
    return null;
  }

  return parsed.data.product;
}
