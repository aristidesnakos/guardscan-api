/**
 * NIH DSLD (Dietary Supplement Label Database) adapter.
 *
 * API docs: https://dsld.od.nih.gov/api-guide
 * Licence: US government, public domain.
 *
 * DSLD has NO barcode lookup endpoint. The scan route relies on our DB cache
 * (populated by the M2 weekly sync). This adapter exposes search + label
 * fetch for use by the cron job.
 *
 * Key quirks:
 *   - `upcSku` is spaced ("0 48107 05843 2") — use `normalizeDsldUpc()`.
 *   - Search hits do NOT include `upcSku` — you need a second `/label/{id}` call.
 *   - Intermittent 500 errors — always use `withRetry()` around fetch calls.
 */

import { z } from 'zod';
import { withRetry } from '@/lib/utils/retry';

// ── Schemas ─────────────────────────────────────────────────────────────────

const dsldIngredientRowSchema = z.object({
  order: z.number().optional(),
  ingredientId: z.number().optional(),
  name: z.string(),
  category: z.string().optional(),
  ingredientGroup: z.string().optional(),
  notes: z.string().nullable().optional(),
  forms: z
    .array(
      z.object({
        name: z.string(),
        category: z.string().optional(),
      }).passthrough(),
    )
    .optional(),
  quantity: z
    .array(
      z.object({
        quantity: z.number().optional(),
        unit: z.string().optional(),
        operator: z.string().optional(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

const dsldOtherIngredientSchema = z.object({
  order: z.number().optional(),
  ingredientId: z.number().optional(),
  name: z.string(),
  category: z.string().optional(),
}).passthrough();

const dsldLabelSchema = z.object({
  id: z.number(),
  fullName: z.string().optional(),
  brandName: z.string().optional(),
  upcSku: z.string().nullable().optional(),
  entryDate: z.string().optional(),
  offMarket: z.number().optional(),
  ingredientRows: z.array(dsldIngredientRowSchema).optional(),
  otheringredients: z
    .object({
      text: z.string().nullable().optional(),
      ingredients: z.array(dsldOtherIngredientSchema).optional(),
    })
    .nullable()
    .optional(),
  servingSizes: z
    .array(
      z.object({
        minQuantity: z.number().optional(),
        maxQuantity: z.number().optional(),
        unit: z.string().optional(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

const dsldSearchHitSchema = z.object({
  _id: z.string(),
  _score: z.number().optional(),
  _source: z.object({
    fullName: z.string().optional(),
    brandName: z.string().optional(),
    entryDate: z.string().optional(),
    offMarket: z.number().optional(),
  }).passthrough(),
}).passthrough();

const dsldSearchResponseSchema = z.object({
  hits: z.array(dsldSearchHitSchema),
  stats: z.object({
    count: z.number(),
  }).passthrough(),
});

export type DsldLabel = z.infer<typeof dsldLabelSchema>;
export type DsldSearchHit = z.infer<typeof dsldSearchHitSchema>;

// ── Fetcher ─────────────────────────────────────────────────────────────────

const DSLD_BASE = 'https://api.ods.od.nih.gov/dsld/v9';

export class DsldFetchError extends Error {
  constructor(
    message: string,
    public readonly context: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DsldFetchError';
  }
}

/**
 * Search DSLD for supplement products by keyword.
 * Returns lightweight search hits — use `fetchDsldLabel()` for full data.
 */
export async function searchDsld(
  query: string,
  options?: { size?: number; from?: number },
): Promise<{ hits: DsldSearchHit[]; total: number }> {
  const { size = 25, from = 0 } = options ?? {};
  const params = new URLSearchParams({
    q: query,
    size: String(size),
    from: String(from),
  });

  const url = `${DSLD_BASE}/search-filter?${params}`;

  const response = await withRetry(
    async () => {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new DsldFetchError(
          `DSLD search returned HTTP ${res.status}`,
          `query="${query}"`,
        );
      }
      return res;
    },
    { label: `dsld-search:${query}` },
  );

  const json = await response.json();
  const parsed = dsldSearchResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new DsldFetchError(
      `DSLD search response failed validation: ${parsed.error.message}`,
      `query="${query}"`,
      parsed.error,
    );
  }

  return { hits: parsed.data.hits, total: parsed.data.stats.count };
}

/**
 * Fetch a full DSLD label by numeric ID.
 * Includes `ingredientRows`, `otheringredients`, and `upcSku`.
 */
export async function fetchDsldLabel(id: string | number): Promise<DsldLabel | null> {
  const url = `${DSLD_BASE}/label/${id}`;

  const response = await withRetry(
    async () => {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new DsldFetchError(
          `DSLD label returned HTTP ${res.status}`,
          `id=${id}`,
        );
      }
      return res;
    },
    { label: `dsld-label:${id}` },
  );

  if (!response) return null;

  const json = await response.json();
  const parsed = dsldLabelSchema.safeParse(json);
  if (!parsed.success) {
    throw new DsldFetchError(
      `DSLD label failed validation for id=${id}: ${parsed.error.message}`,
      `id=${id}`,
      parsed.error,
    );
  }

  return parsed.data;
}

/**
 * Normalize DSLD's spaced UPC format to a standard barcode string.
 * "0 48107 05843 2" → "048107058432"
 * Returns null if the input is empty or not a valid UPC after normalization.
 */
export function normalizeDsldUpc(spaced: string | null | undefined): string | null {
  if (!spaced) return null;
  const digits = spaced.replace(/\s+/g, '');
  // Valid UPC-A is 12 digits, EAN-13 is 13 digits
  if (!/^\d{12,13}$/.test(digits)) return null;
  return digits;
}
