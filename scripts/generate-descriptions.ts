/**
 * Phase 3 — Generate ingredient descriptions via Claude Haiku (OpenRouter).
 *
 * Iterates seed dictionary entries, builds a context-rich prompt from seed
 * fields + PubChem enrichment data, and calls Claude Haiku 4.5 to generate
 * 2-3 paragraph consumer descriptions. Outputs to a JSON review file.
 *
 * Usage:
 *   npx tsx scripts/generate-descriptions.ts                  # all entries
 *   npx tsx scripts/generate-descriptions.ts --only-flagged   # negative + caution only
 *   npx tsx scripts/generate-descriptions.ts --category food  # one category
 *   npx tsx scripts/generate-descriptions.ts --dry            # preview without API calls
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { SEED_ENTRIES, type DictionaryEntry } from '../lib/dictionary/seed';

// ── Bootstrap .env ──────────────────────────────────────────────────────────
{
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const MODEL = 'google/gemma-4-26b-a4b-it';
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

// ── Types ───────────────────────────────────────────────────────────────────

type PubChemResult = {
  normalized: string;
  cid: number | null;
  h_codes: string[];
  pubchem_tags: string[];
};

type PubChemReport = {
  summary: Record<string, unknown>;
  results: PubChemResult[];
};

type DescriptionResult = {
  normalized: string;
  flag: string;
  category: string;
  description: string | null;
  tokens_used: number | null;
  error: string | null;
};

type Report = {
  summary: {
    timestamp: string;
    model: string;
    total: number;
    generated: number;
    failed: number;
    skipped: number;
  };
  results: DescriptionResult[];
};

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { completion_tokens?: number };
  error?: { message?: string };
};

// ── PubChem data loader ─────────────────────────────────────────────────────

function loadPubChemData(): Map<string, PubChemResult> {
  const reportPath = resolve(__dirname, 'output', 'pubchem-report.json');
  if (!existsSync(reportPath)) {
    console.log('[gen] PubChem report not found — proceeding without H-code context');
    return new Map();
  }
  const report: PubChemReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
  const map = new Map<string, PubChemResult>();
  for (const r of report.results) {
    map.set(r.normalized, r);
  }
  console.log(`[gen] Loaded PubChem data for ${map.size} entries`);
  return map;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(entry: DictionaryEntry, pubchem: PubChemResult | undefined): string {
  const lines = [
    `Ingredient: ${entry.normalized}`,
    `Category: ${entry.category}`,
    `Safety flag: ${entry.flag}`,
    `Reason: ${entry.reason}`,
    `Ingredient group: ${entry.ingredient_group}`,
    `Health risk tags: ${entry.health_risk_tags.length > 0 ? entry.health_risk_tags.join(', ') : 'none'}`,
    `Fertility relevant: ${entry.fertility_relevant}`,
    `Testosterone relevant: ${entry.testosterone_relevant}`,
  ];

  if (pubchem?.cid) {
    lines.push(`PubChem CID: ${pubchem.cid}`);
  }
  if (pubchem?.h_codes && pubchem.h_codes.length > 0) {
    lines.push(`GHS H-codes: ${pubchem.h_codes.join(', ')}`);
  }
  if (pubchem?.pubchem_tags && pubchem.pubchem_tags.length > 0) {
    lines.push(`PubChem risk tags: ${pubchem.pubchem_tags.join(', ')}`);
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are a men's health product safety expert writing for the GuardScan app (Mangood brand — focused on men's grooming, food, and supplements).

Write a 2-3 paragraph plain text description of the given ingredient for a consumer audience.

Paragraph 1: What it is and where it's commonly found.
Paragraph 2: Known health effects with evidence level. If the ingredient is fertility-relevant or testosterone-relevant, specifically mention the relevance to male reproductive health.
Paragraph 3: Regulatory context (CIR, SCCS, EFSA, FDA as applicable). Concentration or usage nuances if relevant (e.g., rinse-off vs leave-on for grooming).

Rules:
- Plain text only. No markdown, no HTML, no bullet points.
- Separate paragraphs with a blank line.
- Do not fabricate citations or invent study details.
- Keep under 200 words total.
- Consumer-friendly language, not academic jargon.
- Be factual and balanced — state what evidence shows without being alarmist.`;

// ── OpenRouter call ─────────────────────────────────────────────────────────

async function generateDescription(
  entry: DictionaryEntry,
  pubchem: PubChemResult | undefined,
): Promise<DescriptionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      normalized: entry.normalized,
      flag: entry.flag,
      category: entry.category,
      description: null,
      tokens_used: null,
      error: 'OPENROUTER_API_KEY not set',
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://guardscan.app',
        'X-Title': 'GuardScan ingredient descriptions',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(entry, pubchem) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        normalized: entry.normalized,
        flag: entry.flag,
        category: entry.category,
        description: null,
        tokens_used: null,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as OpenRouterResponse;
    if (data.error) {
      return {
        normalized: entry.normalized,
        flag: entry.flag,
        category: entry.category,
        description: null,
        tokens_used: null,
        error: `API error: ${data.error.message}`,
      };
    }

    const content = data.choices?.[0]?.message?.content?.trim() ?? null;
    return {
      normalized: entry.normalized,
      flag: entry.flag,
      category: entry.category,
      description: content,
      tokens_used: data.usage?.completion_tokens ?? null,
      error: content ? null : 'Empty response',
    };
  } catch (err) {
    return {
      normalized: entry.normalized,
      flag: entry.flag,
      category: entry.category,
      description: null,
      tokens_used: null,
      error: String(err),
    };
  }
}

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const onlyFlagged = args.includes('--only-flagged');

  let category: string | null = null;
  const catIdx = args.indexOf('--category');
  if (catIdx !== -1 && args[catIdx + 1]) {
    category = args[catIdx + 1];
  }

  return { dry, onlyFlagged, category };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { dry, onlyFlagged, category } = parseArgs();
  const pubchemMap = loadPubChemData();

  console.log('[gen] Phase 3 — Ingredient Description Generation');
  console.log(`[gen] Model: ${MODEL}`);
  console.log('═══════════════════════════════════════════════\n');

  // Filter entries
  let entries = [...SEED_ENTRIES];
  if (onlyFlagged) {
    entries = entries.filter((e) => e.flag === 'negative' || e.flag === 'caution');
    console.log(`[gen] Filter: --only-flagged → ${entries.length} entries`);
  }
  if (category) {
    entries = entries.filter((e) => e.category === category);
    console.log(`[gen] Filter: --category ${category} → ${entries.length} entries`);
  }
  console.log(`[gen] Processing ${entries.length} of ${SEED_ENTRIES.length} total entries\n`);

  if (dry) {
    console.log('[gen] DRY RUN — listing entries without API calls:\n');
    for (const e of entries) {
      const pub = pubchemMap.get(e.normalized);
      const cidInfo = pub?.cid ? `CID ${pub.cid}` : 'no CID';
      console.log(`  ${e.normalized.padEnd(42)} ${e.flag.padEnd(10)} ${e.category.padEnd(12)} ${cidInfo}`);
    }
    console.log(`\n[gen] ${entries.length} entries would be processed.`);
    return;
  }

  // Check API key
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[gen] OPENROUTER_API_KEY not set. Add it to .env or export it.');
    process.exit(1);
  }

  // Process in batches
  const results: DescriptionResult[] = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(entries.length / BATCH_SIZE);
    console.log(`[gen] Batch ${batchNum}/${totalBatches} (${batch.map((e) => e.normalized).join(', ')})`);

    const batchResults = await Promise.allSettled(
      batch.map((entry) => generateDescription(entry, pubchemMap.get(entry.normalized))),
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        const r = settled.value;
        if (r.description) {
          console.log(`  ✓ ${r.normalized} (${r.tokens_used ?? '?'} tokens)`);
        } else {
          console.log(`  ✗ ${r.normalized}: ${r.error}`);
        }
        results.push(r);
      } else {
        console.log(`  ✗ batch error: ${settled.reason}`);
      }
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < entries.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  // Summary
  const generated = results.filter((r) => r.description !== null).length;
  const failed = results.filter((r) => r.description === null).length;

  console.log('\n═══════════════════════════════════════════════');
  console.log('[gen] Summary\n');
  console.log(`  Total processed:  ${results.length}`);
  console.log(`  Generated:        ${generated}`);
  console.log(`  Failed:           ${failed}`);

  if (failed > 0) {
    console.log('\n── Failed entries ──');
    for (const r of results.filter((r) => r.description === null)) {
      console.log(`  ${r.normalized}: ${r.error}`);
    }
  }

  // Write report
  const report: Report = {
    summary: {
      timestamp: new Date().toISOString(),
      model: MODEL,
      total: entries.length,
      generated,
      failed,
      skipped: SEED_ENTRIES.length - entries.length,
    },
    results,
  };

  const outputDir = resolve(__dirname, 'output');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, 'descriptions.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n[gen] Report written to ${outputPath}`);
}

main().catch((err) => {
  console.error('[gen] Fatal error:', err);
  process.exit(1);
});
