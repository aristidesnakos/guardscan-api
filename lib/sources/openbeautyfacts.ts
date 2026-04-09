/**
 * Open Beauty Facts v2 adapter.
 *
 * Docs: https://world.openbeautyfacts.org/data
 * Licence: ODbL — attribution required in the app's About screen.
 *
 * OBF's API is 98% identical to Open Food Facts (same maintainers, same data
 * format). Key differences: no Nutri-Score fields, `product_type` is "beauty".
 *
 * Normalization to the canonical `Product` type lives in `lib/normalize.ts`.
 */

import { z } from 'zod';

// ── Schema ──────────────────────────────────────────────────────────────────

const ingredientSchema = z
  .object({
    id: z.string().optional(),
    text: z.string().optional(),
    rank: z.number().optional(),
    vegan: z.string().optional(),
    vegetarian: z.string().optional(),
  })
  .passthrough();

const obfProductSchema = z
  .object({
    code: z.string().optional(),
    product_name: z.string().optional(),
    product_name_en: z.string().optional(),
    brands: z.string().optional(),
    image_front_url: z.string().url().optional(),
    image_ingredients_url: z.string().url().optional(),
    ingredients_text: z.string().optional(),
    ingredients_text_en: z.string().optional(),
    ingredients: z.array(ingredientSchema).optional(),
    categories: z.string().optional(),
    categories_tags: z.array(z.string()).optional(),
  })
  .passthrough();

const obfResponseSchema = z.object({
  status: z.number(), // 0 = not found, 1 = found
  code: z.string().optional(),
  product: obfProductSchema.optional(),
});

export type ObfProduct = z.infer<typeof obfProductSchema>;

// ── Fetcher ─────────────────────────────────────────────────────────────────

const OBF_BASE = 'https://world.openbeautyfacts.org/api/v2/product';

export class ObfFetchError extends Error {
  constructor(
    message: string,
    public readonly barcode: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ObfFetchError';
  }
}

/**
 * Fetches a single product from OBF by barcode.
 *
 * @returns the parsed product, or `null` if OBF reports status=0 (not found).
 * @throws `ObfFetchError` on network failure, non-200, or schema validation failure.
 */
export async function fetchObfProduct(barcode: string): Promise<ObfProduct | null> {
  const userAgent = process.env.OFF_USER_AGENT;
  if (!userAgent) {
    throw new ObfFetchError(
      'OFF_USER_AGENT env var is required by Open Beauty Facts. ' +
        'Set it to e.g. "GuardScan/1.0 (contact@example.com)".',
      barcode,
    );
  }

  const fields = [
    'code',
    'product_name',
    'product_name_en',
    'brands',
    'image_front_url',
    'image_ingredients_url',
    'ingredients_text',
    'ingredients_text_en',
    'ingredients',
    'categories',
    'categories_tags',
  ].join(',');

  const url = `${OBF_BASE}/${encodeURIComponent(barcode)}?fields=${fields}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new ObfFetchError(`Network error calling OBF for ${barcode}`, barcode, err);
  }

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new ObfFetchError(
      `OBF returned HTTP ${response.status} for ${barcode}`,
      barcode,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new ObfFetchError(`OBF returned invalid JSON for ${barcode}`, barcode, err);
  }

  const parsed = obfResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ObfFetchError(
      `OBF response failed schema validation for ${barcode}: ${parsed.error.message}`,
      barcode,
      parsed.error,
    );
  }

  if (parsed.data.status === 0 || !parsed.data.product) {
    return null;
  }

  return parsed.data.product;
}
