/**
 * Runtime translation helpers for the ingest claim flow.
 *
 * Background — see db/migrations/0008_translation_columns.sql.
 * Catalog contract: `products.name` is US English. Upstream (OBF community)
 * emits foreign names in ~9.5% of rows. The cron previously clobbered any
 * translation within 24h. This module is the runtime equivalent of
 * `scripts/translate-names.ts`, called synchronously from `upsertProduct`.
 *
 * Two responsibilities:
 *   - `looksForeign(name)` — fast precision-leaning heuristic. The LLM is the
 *     final arbiter, but we don't want to burn a token on every English row.
 *   - `translateProductName({ name, brand, category })` — single-row LLM call
 *     returning the translated name + detected language, or null on any
 *     failure / timeout / API error. Never throws.
 *
 * Synchronous use note: the call sits inside `upsertProduct`'s DB transaction.
 * Timeout is short (5s) so we don't hold the row lock long. On failure, the
 * caller writes `translation_status='failed'` and the row retries on next
 * ingest sight.
 */

import { log } from '@/lib/logger';

// ── English-loanword allowlist ─────────────────────────────────────────────
//
// Words that LOOK foreign (diacritic or foreign-origin) but are intentional
// English product names. If the only foreign signal is one of these, treat as
// English. Pomenatal especially — postpartum supplements drop a lot of
// botanical names that read foreign.

const ENGLISH_ALLOWLIST: readonly string[] = [
  'maté', 'mate', 'yerba',
  'açaí', 'acai', 'kombucha', 'kefir', 'edamame',
  'naïve', 'naive',
  'café', 'cafe', 'résumé', 'resume', 'soufflé', 'souffle',
  'crème brûlée', 'creme brulee',
];

// ── Foreign-token heuristic ────────────────────────────────────────────────
//
// Mirrors the spike script `scripts/translate-names.ts` token list. Wide net:
// false positives get caught by the LLM (returns is_english=true) and
// short-circuit at zero DB cost. Missing a real foreign row is more costly
// than a probe call.

const FOREIGN_TOKENS: readonly string[] = [
  // French
  'crème', 'creme', 'après', 'apres', 'démaquillant', 'demaquillant',
  'hydratant', 'rasage', 'shampooing', 'mousse à raser', 'mousse a raser',
  'baume', 'soin', 'lait corporel', 'gel douche', 'pour homme', 'pour femme',
  // Italian
  'crema', 'schiuma', 'doccia', 'bagnoschiuma', 'dopobarba', 'sapone',
  'detergente', 'idratante', 'capelli', 'barba',
  // German
  'rasierschaum', 'rasiergel', 'rasiercreme', 'rasierseife', 'duschgel',
  'gesichts', 'haarshampoo', 'körper', 'koerper', 'fur männer', 'für männer',
  // Dutch
  'scheercrème', 'scheercreme', 'scheerschuim', 'douchegel', 'dagcrème',
  'dagcreme', 'nachtcrème', 'nachtcreme', 'gezichtscrème', 'gezichtscreme',
  'hydraterende', 'zonnebrand', 'voor mannen', 'voor heren', 'lichaam',
  // Spanish
  'champu', 'champú', 'jabón', 'jabon', 'loción', 'locion',
  'después', 'despues', 'para hombre', 'para hombres',
  // Portuguese
  'champô', 'champo', 'sabonete', 'loção', 'locao', 'barbear', 'depois',
];

const DIACRITIC_RE = /[àáâãäåèéêëìíîïòóôõöùúûüçñßœæ]/i;

/**
 * Fast pre-filter — true means "worth probing the LLM." Wide net by design.
 *
 * Returns false for names whose only foreign signal is an English-allowlist
 * token (Maté, Naïve, Açaí, …). Those are intentional English; translating
 * them produces garbage.
 */
export function looksForeign(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();

  // Strip allowlist hits before checking for foreign signals
  let stripped = lower;
  for (const allow of ENGLISH_ALLOWLIST) {
    stripped = stripped.replaceAll(allow, '');
  }

  if (DIACRITIC_RE.test(stripped)) return true;
  for (const tok of FOREIGN_TOKENS) {
    if (stripped.includes(tok)) return true;
  }
  return false;
}

// ── LLM call ───────────────────────────────────────────────────────────────

export type TranslateResult = {
  is_english: boolean;
  language: string;
  translated: string;
};

const SYSTEM_PROMPT = [
  'You translate consumer product names to natural US English for an English-speaking audience.',
  '',
  'RULES:',
  '- Translate ONLY what is in the source. Do NOT add the brand to the translated name even when a brand is provided as context — the brand lives in a separate column.',
  '- If the source name contains a brand inline (e.g. "Williams Après-Rasage…"), preserve it inline. If it does not, do not add one.',
  '- Preserve brand names verbatim wherever they appear (L\'Oréal, Naïve, Nivea, Garnier, Axe, etc.). Brand identity does not translate.',
  '- Preserve size/volume annotations exactly (125ml, 250 g, 50 ml, 6.7 fl oz).',
  '- Use US English conventions (Moisturizer not Moisturiser, Color not Colour).',
  '- Keep the product type clear and concise: "Shaving Foam", "Aftershave Balm", "Shower Gel", "Body Lotion", "Sunscreen SPF 50".',
  '- Do not invent flavors, scents, or claims that are not in the source.',
  '- If the name is already English, return it unchanged with is_english: true.',
  '- If the source is ambiguous or untranslatable, return your best-effort and set language to "unknown".',
  '',
  'EXAMPLES:',
  '  Brand: L\'Oréal  Name: "Ultra doux après-shampooing nutrition intense"',
  '    → "Ultra Doux Intense Nourishment Conditioner"  (NOT "L\'Oréal Ultra Doux...")',
  '  Brand: Williams  Name: "Williams Après-Rasage Savane Vert Sauvage 125ml"',
  '    → "Williams Aftershave Wild Green Savanna 125ml"  (brand was in the source, keep it)',
  '  Brand: Cosmia Bio  Name: "Creme visage eclat a la vitamine c"',
  '    → "Vitamin C Radiance Face Cream"  (brand was NOT in the source, don\'t add it)',
  '',
  'Respond with JSON ONLY, no prose, no markdown fences:',
  '{"is_english": boolean, "language": "fr"|"it"|"de"|"nl"|"es"|"pt"|"en"|"unknown", "translated": "..."}',
].join('\n');

function userPrompt(name: string, brand: string | null, category: string): string {
  return [
    `Category: ${category}`,
    `Brand: ${brand ?? '(unknown)'}`,
    `Product name: ${name}`,
    '',
    'JSON:',
  ].join('\n');
}

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string; code?: number | string };
};

const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// Hard cap so a slow provider can't stall the OBF cron. The row simply gets
// translation_status='failed' and retries on next ingest sight.
const TIMEOUT_MS = 5_000;

export type TranslateInput = {
  name: string;
  brand: string | null;
  category: string;
};

/**
 * Translate one product name. Returns null on any failure — never throws.
 * Caller writes translation_status='failed' so the row is retry-eligible.
 *
 * Returns the raw LLM result (including is_english: true) so the caller can
 * distinguish "LLM said it's actually English" from "translation succeeded."
 */
export async function translateProductName(
  input: TranslateInput,
): Promise<TranslateResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (!input.name || input.name.trim().length === 0) return null;

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
  const model =
    process.env.OPENROUTER_TRANSLATOR_MODEL ??
    process.env.OPENROUTER_MODEL ??
    DEFAULT_MODEL;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://guardscan.app',
        'X-Title': 'GuardScan name translator (intake)',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(input.name, input.brand, input.category) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('translate_http_error', {
        name: input.name,
        status: res.status,
        body: body.slice(0, 200),
      });
      return null;
    }

    const data = (await res.json()) as OpenRouterResponse;
    if (data.error) {
      log.warn('translate_api_error', {
        name: input.name,
        error: data.error,
      });
      return null;
    }

    const raw = data.choices?.[0]?.message?.content ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(cleaned) as Partial<TranslateResult>;
    if (
      typeof parsed.is_english !== 'boolean' ||
      typeof parsed.translated !== 'string' ||
      typeof parsed.language !== 'string'
    ) {
      log.warn('translate_shape_invalid', { name: input.name, raw: raw.slice(0, 200) });
      return null;
    }
    return parsed as TranslateResult;
  } catch (err) {
    log.warn('translate_failed', {
      name: input.name,
      error: String(err),
    });
    return null;
  }
}

/** Returns true when the translator is wired (API key present). */
export function isTranslatorEnabled(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}
