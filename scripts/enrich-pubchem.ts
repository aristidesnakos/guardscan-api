/**
 * Phase 2 — PubChem Enrichment Script
 *
 * Iterates all seed dictionary entries, resolves PubChem CIDs, fetches GHS
 * hazard statements, maps H-codes → health_risk_tags, and compares with the
 * manually-assigned Phase 1 tags. Outputs a discrepancy report for human review
 * and a JSON report with CID mappings for scripts/apply-cids.ts.
 *
 * Usage:
 *   npx tsx scripts/enrich-pubchem.ts                  # all entries
 *   npx tsx scripts/enrich-pubchem.ts --only-flagged   # negative + caution only
 *   npx tsx scripts/enrich-pubchem.ts --category food   # one category
 *   npx tsx scripts/enrich-pubchem.ts --dry             # preview without API calls
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { SEED_ENTRIES, type DictionaryEntry } from '../lib/dictionary/seed';

// ── H-Code → GuardScan risk tag mapping ─────────────────────────────────────
// Identical to scripts/audit-ingredient-sources.ts

const H_CODE_TO_TAG: Record<string, string> = {
  H302: 'organ_toxicant',
  H311: 'organ_toxicant',
  H315: 'irritant',
  H317: 'allergen',
  H318: 'irritant',
  H319: 'irritant',
  H335: 'irritant',
  H340: 'carcinogen',
  H350: 'carcinogen',
  H360: 'reproductive_toxin',
  H361: 'reproductive_toxin',
  H370: 'organ_toxicant',
  H372: 'organ_toxicant',
  H400: 'environmental',
  H410: 'environmental',
  H411: 'environmental',
};

// Tags that have no GHS H-code equivalent — assigned from literature only.
// These should NOT be flagged as "extra" in discrepancy reports.
const LITERATURE_ONLY_TAGS = new Set(['endocrine_disruptor', 'gut_disruptor']);

// ── Types ────────────────────────────────────────────────────────────────────

type Discrepancy = {
  type: 'missing_tag' | 'extra_tag';
  tag: string;
  detail: string;
};

type EnrichmentResult = {
  normalized: string;
  flag: string;
  category: string;
  ingredient_group: string;
  cid: number | null;
  cid_resolved_via: string | null; // which name resolved the CID
  h_codes: string[];
  pubchem_tags: string[];
  manual_tags: string[];
  discrepancies: Discrepancy[];
  error?: string;
};

type ReportSummary = {
  timestamp: string;
  total_entries: number;
  processed: number;
  cids_resolved: number;
  cids_failed: number;
  with_discrepancies: number;
  discrepancy_breakdown: { missing_tag: number; extra_tag: number };
};

type Report = {
  summary: ReportSummary;
  results: EnrichmentResult[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function log(msg: string) {
  console.log(`[enrich] ${msg}`);
}

function warn(msg: string) {
  console.log(`[enrich] ⚠ ${msg}`);
}

// ── PubChem API ──────────────────────────────────────────────────────────────

async function resolveCID(name: string): Promise<{ cid: number | null; error?: string }> {
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/cids/JSON`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { cid: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    const cid = data?.IdentifierList?.CID?.[0] ?? null;
    return cid ? { cid } : { cid: null, error: 'No CID returned' };
  } catch (err) {
    return { cid: null, error: `${err}` };
  }
}

type HCodeResult = { mapped: string[]; all: string[] };

function extractHCodes(data: unknown): HCodeResult {
  const json = JSON.stringify(data);
  const mapped: string[] = [];
  const all: string[] = [];

  const matches = json.match(/H\d{3}/g);
  if (matches) {
    const seen = new Set<string>();
    for (const m of matches) {
      if (seen.has(m)) continue;
      seen.add(m);
      all.push(m);
      if (m in H_CODE_TO_TAG) mapped.push(m);
    }
  }
  return { mapped, all };
}

async function fetchGHS(cid: number): Promise<{ hCodes: HCodeResult; error?: string }> {
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON?heading=Safety+and+Hazards`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { hCodes: { mapped: [], all: [] }, error: `GHS fetch HTTP ${res.status}` };
    }
    const data = await res.json();
    return { hCodes: extractHCodes(data) };
  } catch (err) {
    return { hCodes: { mapped: [], all: [] }, error: `GHS fetch error: ${err}` };
  }
}

// ── Discrepancy detection ────────────────────────────────────────────────────

function findDiscrepancies(pubchemTags: string[], manualTags: string[]): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const pubchemSet = new Set(pubchemTags);
  const manualSet = new Set(manualTags);

  // Tags PubChem suggests but manual assignment doesn't have
  for (const tag of pubchemTags) {
    if (!manualSet.has(tag)) {
      discrepancies.push({
        type: 'missing_tag',
        tag,
        detail: `PubChem H-codes suggest "${tag}" but not in manual tags`,
      });
    }
  }

  // Tags in manual assignment but not in PubChem
  // Skip literature-only tags (endocrine_disruptor, gut_disruptor) — expected
  for (const tag of manualTags) {
    if (!pubchemSet.has(tag) && !LITERATURE_ONLY_TAGS.has(tag)) {
      discrepancies.push({
        type: 'extra_tag',
        tag,
        detail: `Manual tag "${tag}" not supported by PubChem H-codes (may be valid from other sources)`,
      });
    }
  }

  return discrepancies;
}

// ── Process single entry ─────────────────────────────────────────────────────

async function processEntry(entry: DictionaryEntry): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    normalized: entry.normalized,
    flag: entry.flag,
    category: entry.category,
    ingredient_group: entry.ingredient_group,
    cid: null,
    cid_resolved_via: null,
    h_codes: [],
    pubchem_tags: [],
    manual_tags: [...entry.health_risk_tags],
    discrepancies: [],
  };

  // Step 1: Resolve CID — try normalized name first, then aliases
  const namesToTry = [entry.normalized, ...entry.aliases];
  for (const name of namesToTry) {
    const resolved = await resolveCID(name);
    if (resolved.cid) {
      result.cid = resolved.cid;
      result.cid_resolved_via = name;
      break;
    }
    await delay(200);
  }

  if (!result.cid) {
    result.error = 'CID resolution failed for all names';
    return result;
  }

  await delay(200);

  // Step 2: Fetch GHS data
  const ghs = await fetchGHS(result.cid);
  if (ghs.error) {
    result.error = ghs.error;
    // Still have CID, just no GHS data — that's OK for food additives
  }

  result.h_codes = ghs.hCodes.mapped;
  result.pubchem_tags = [...new Set(ghs.hCodes.mapped.map((h) => H_CODE_TO_TAG[h]).filter(Boolean))];

  // Step 3: Compare tags (only for negative/caution — positive entries shouldn't have tags)
  if (entry.flag === 'negative' || entry.flag === 'caution') {
    result.discrepancies = findDiscrepancies(result.pubchem_tags, result.manual_tags);
  }

  return result;
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { dry, onlyFlagged, category } = parseArgs();

  log('Phase 2 — PubChem Enrichment');
  log('═══════════════════════════════════════════════\n');

  // Filter entries
  let entries = [...SEED_ENTRIES];
  if (onlyFlagged) {
    entries = entries.filter((e) => e.flag === 'negative' || e.flag === 'caution');
    log(`Filter: --only-flagged → ${entries.length} negative/caution entries`);
  }
  if (category) {
    entries = entries.filter((e) => e.category === category);
    log(`Filter: --category ${category} → ${entries.length} entries`);
  }
  log(`Processing ${entries.length} of ${SEED_ENTRIES.length} total entries\n`);

  if (dry) {
    log('DRY RUN — listing entries without API calls:\n');
    for (const e of entries) {
      const tags = e.health_risk_tags.length > 0 ? e.health_risk_tags.join(', ') : '(none)';
      log(`  ${e.normalized.padEnd(40)} ${e.flag.padEnd(10)} ${e.category.padEnd(12)} tags: ${tags}`);
    }
    log(`\n${entries.length} entries would be processed.`);
    return;
  }

  // Process entries
  const results: EnrichmentResult[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const progress = `[${i + 1}/${entries.length}]`;
    log(`${progress} ${entry.normalized} (${entry.flag}, ${entry.category})`);

    const result = await processEntry(entry);

    if (result.cid) {
      log(`  ✓ CID ${result.cid} via "${result.cid_resolved_via}"`);
      if (result.h_codes.length > 0) {
        log(`  ✓ ${result.h_codes.length} mapped H-codes → tags: ${result.pubchem_tags.join(', ')}`);
      } else {
        log(`  · No mapped H-codes (${result.error || 'no GHS data'})`);
      }
    } else {
      warn(`✗ No CID — ${result.error}`);
    }

    if (result.discrepancies.length > 0) {
      for (const d of result.discrepancies) {
        const icon = d.type === 'missing_tag' ? '⊕' : '⊖';
        warn(`${icon} ${d.type}: ${d.tag} — ${d.detail}`);
      }
    }

    results.push(result);

    // Rate limit between entries
    if (i < entries.length - 1) await delay(200);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const cidsResolved = results.filter((r) => r.cid !== null).length;
  const cidsFailed = results.filter((r) => r.cid === null).length;
  const withDiscrepancies = results.filter((r) => r.discrepancies.length > 0).length;
  const missingTagCount = results.reduce(
    (sum, r) => sum + r.discrepancies.filter((d) => d.type === 'missing_tag').length,
    0,
  );
  const extraTagCount = results.reduce(
    (sum, r) => sum + r.discrepancies.filter((d) => d.type === 'extra_tag').length,
    0,
  );

  log('\n═══════════════════════════════════════════════');
  log('Summary\n');
  log(`  Total processed:    ${results.length}`);
  log(`  CIDs resolved:      ${cidsResolved} (${Math.round((cidsResolved / results.length) * 100)}%)`);
  log(`  CIDs failed:        ${cidsFailed}`);
  log(`  With discrepancies: ${withDiscrepancies}`);
  log(`    missing_tag:      ${missingTagCount}`);
  log(`    extra_tag:        ${extraTagCount}`);

  // List failed CID resolutions
  if (cidsFailed > 0) {
    log('\n── Failed CID resolutions ──');
    for (const r of results.filter((r) => r.cid === null)) {
      log(`  ${r.normalized} (${r.category})`);
    }
  }

  // List discrepancies
  if (withDiscrepancies > 0) {
    log('\n── Discrepancies requiring review ──');
    for (const r of results.filter((r) => r.discrepancies.length > 0)) {
      log(`  ${r.normalized}:`);
      for (const d of r.discrepancies) {
        log(`    ${d.type}: ${d.tag}`);
      }
    }
  }

  // ── Write JSON report ───────────────────────────────────────────────────
  const report: Report = {
    summary: {
      timestamp: new Date().toISOString(),
      total_entries: SEED_ENTRIES.length,
      processed: results.length,
      cids_resolved: cidsResolved,
      cids_failed: cidsFailed,
      with_discrepancies: withDiscrepancies,
      discrepancy_breakdown: {
        missing_tag: missingTagCount,
        extra_tag: extraTagCount,
      },
    },
    results,
  };

  const outputDir = resolve(__dirname, 'output');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, 'pubchem-report.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  log(`\nReport written to ${outputPath}`);
}

main().catch((err) => {
  console.error('[enrich] Fatal error:', err);
  process.exit(1);
});
