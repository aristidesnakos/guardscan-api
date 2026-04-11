/**
 * LLM-backed subcategory classifier (OpenRouter-compatible).
 *
 * Fallback layer behind `inferSubcategory()` in lib/subcategory.ts. The
 * keyword pass handles obvious cases for free; this classifier handles names
 * that contain none of our anchor words ("Wood Barrel Bourbon", "Nivea Fresh
 * Active", etc.). Every product gets classified at most once, at ingest
 * time — the result is cached in products.subcategory forever. The scan hot
 * path continues to call the sync keyword pass directly, never this.
 *
 * Model choice:
 *   Defaults to `qwen/qwen-2.5-7b-instruct`. At ~$0.06/M input + $0.15/M
 *   output via OpenRouter, 10k classifications cost ~$0.09. Override with
 *   OPENROUTER_CLASSIFIER_MODEL if you want something different — keep it
 *   cheap and instruction-tuned.
 *
 * Env:
 *   OPENROUTER_API_KEY            required; when absent, LLM fallback is a no-op
 *   OPENROUTER_CLASSIFIER_MODEL   optional, defaults to qwen/qwen-2.5-7b-instruct
 *   OPENROUTER_BASE_URL           optional, defaults to https://openrouter.ai/api/v1
 *
 * Determinism: temperature=0 plus a constrained prompt + server-side
 * validation against SUBCATEGORY_HINTS gives ~stable output. Anything that
 * fails validation is coerced back to null so we never persist garbage.
 *
 * TODO(multi-brand): The vocabulary in SUBCATEGORY_HINTS (lib/subcategory.ts)
 * is Mangood-tuned — grooming / men's supplements / food. Pomenatal's product
 * mix (prenatal vitamins, maternal food, postpartum care) will be miss-classified
 * by this prompt because there are no anchor words for prenatal_vitamin,
 * maternal_snack, nursing_balm, etc. Likely refactor: extend SUBCATEGORY_HINTS
 * with a `brand` scope, or pass a brand-specific vocabulary into this
 * classifier. See docs/multi-brand-migration.md.
 */

import type { ProductCategory } from '@/types/guardscan';
import {
  SUBCATEGORY_HINTS,
  inferSubcategory,
} from '@/lib/subcategory';
import { log } from '@/lib/logger';

const DEFAULT_MODEL = 'qwen/qwen-2.5-7b-instruct';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const VOCABULARY: readonly string[] = SUBCATEGORY_HINTS.map((h) => h.key);
const VALID_KEYS = new Set<string>(VOCABULARY);

/**
 * System prompt enumerates the full vocabulary so the model physically
 * can't emit a novel label in practice. We still validate defensively.
 */
function systemPrompt(): string {
  return [
    'You classify consumer product names into one of a fixed set of subcategories.',
    'Respond with EXACTLY ONE token from the allowed list below, or the single word "null" if nothing fits.',
    'Do not explain. Do not add punctuation, quotes, or any other text.',
    '',
    'Allowed subcategories:',
    VOCABULARY.join(', '),
  ].join('\n');
}

function userPrompt(name: string, category: ProductCategory): string {
  return [
    `Top-level category: ${category}`,
    `Product name: ${name}`,
    'Subcategory:',
  ].join('\n');
}

/** Parse a model response, returning a valid key or null. */
function parseResponse(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip anything that isn't [a-z_]; models sometimes add quotes, periods,
  // or wrap the answer in backticks despite instructions.
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z_]/g, '');
  if (!cleaned || cleaned === 'null') return null;
  return VALID_KEYS.has(cleaned) ? cleaned : null;
}

/**
 * Runs only the LLM classifier. Returns null if:
 *   - OPENROUTER_API_KEY is unset
 *   - the model errors
 *   - the response can't be coerced to a valid vocabulary key
 *
 * Callers should prefer `inferSubcategoryHybrid()` which tries keywords first.
 */
type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: number | string };
};

export async function classifySubcategoryWithLlm(
  name: string,
  category: ProductCategory,
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (!name || name.trim().length === 0) return null;

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.OPENROUTER_CLASSIFIER_MODEL ?? DEFAULT_MODEL;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://guardscan.app',
        'X-Title': 'GuardScan subcategory classifier',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 10,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(name, category) },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('llm_classifier_http_error', {
        name,
        category,
        status: res.status,
        body: text.slice(0, 200),
      });
      return null;
    }

    const data = (await res.json()) as OpenRouterResponse;
    if (data.error) {
      log.warn('llm_classifier_api_error', {
        name,
        category,
        error: data.error,
      });
      return null;
    }
    const raw = data.choices?.[0]?.message?.content ?? null;
    return parseResponse(raw);
  } catch (err) {
    log.warn('llm_classifier_failed', {
      name,
      category,
      error: String(err),
    });
    return null;
  }
}

/**
 * Hybrid inference: keyword pass first (deterministic, free), LLM fallback
 * only when keywords return null. This is the function every ingest path
 * should call — scan path stays on the sync `inferSubcategory()`.
 */
export async function inferSubcategoryHybrid(
  name: string,
  category: ProductCategory,
  categoryTags?: string[],
): Promise<string | null> {
  const fromKeywords = inferSubcategory(name, category, categoryTags);
  if (fromKeywords) return fromKeywords;
  return classifySubcategoryWithLlm(name, category);
}

/** Returns true when the LLM fallback is available. */
export function isLlmClassifierEnabled(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}
