/**
 * Phase 3 — Apply generated descriptions to seed.ts
 *
 * Reads the descriptions.json report from generate-descriptions.ts and writes
 * approved descriptions back into lib/dictionary/seed.ts. Run this AFTER
 * reviewing the generated descriptions.
 *
 * Usage:
 *   npx tsx scripts/apply-descriptions.ts          # write descriptions to seed.ts
 *   npx tsx scripts/apply-descriptions.ts --dry    # preview changes without writing
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

type DescriptionEntry = {
  normalized: string;
  description: string | null;
  error: string | null;
};

type Report = {
  summary: Record<string, unknown>;
  results: DescriptionEntry[];
};

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const dry = process.argv.includes('--dry');
  const reportPath = resolve(__dirname, 'output', 'descriptions.json');
  const seedPath = resolve(__dirname, '..', 'lib', 'dictionary', 'seed.ts');

  // Validate inputs
  if (!existsSync(reportPath)) {
    console.error(`[apply-desc] Report not found: ${reportPath}`);
    console.error('[apply-desc] Run "npx tsx scripts/generate-descriptions.ts" first.');
    process.exit(1);
  }

  const report: Report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  const withDescriptions = report.results.filter((r) => r.description !== null && r.description.trim().length > 0);

  if (withDescriptions.length === 0) {
    console.log('[apply-desc] No descriptions to apply.');
    return;
  }

  console.log(`[apply-desc] Found ${withDescriptions.length} descriptions in report`);

  let seedContent = readFileSync(seedPath, 'utf-8');
  let applied = 0;
  let skipped = 0;

  for (const entry of withDescriptions) {
    const normalizedEscaped = entry.normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Find the entry block in seed.ts
    const blockPattern = new RegExp(
      `(normalized:\\s*'${normalizedEscaped}',\\n)`,
    );
    const match = seedContent.match(blockPattern);
    if (!match) {
      console.log(`[apply-desc] ⚠ Could not find entry for "${entry.normalized}" in seed.ts — skipping`);
      skipped++;
      continue;
    }

    // Check if description already exists for this entry
    const matchIndex = seedContent.indexOf(match[0]);
    const blockSlice = seedContent.slice(matchIndex, matchIndex + 800);
    if (blockSlice.includes('description:')) {
      if (dry) {
        console.log(`[apply-desc] · ${entry.normalized} — already has description, skipping`);
      }
      skipped++;
      continue;
    }

    // Find the evidence_url line for this entry and insert description after it.
    // Use backtick template literal to handle multi-paragraph text cleanly.
    const evidenceLinePattern = new RegExp(
      `(normalized:\\s*'${normalizedEscaped}',[\\s\\S]*?evidence_url:\\s*'[^']*',\\n)`,
    );
    const evidenceMatch = seedContent.match(evidenceLinePattern);

    if (!evidenceMatch) {
      console.log(`[apply-desc] ⚠ Could not find evidence_url for "${entry.normalized}" — skipping`);
      skipped++;
      continue;
    }

    // Escape backticks and ${} in the description for template literal safety
    const safeDescription = entry.description!
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${');

    const insertion = `    description: \`${safeDescription}\`,\n`;
    seedContent = seedContent.replace(evidenceMatch[0], evidenceMatch[0] + insertion);
    applied++;

    if (dry) {
      const preview = entry.description!.slice(0, 80).replace(/\n/g, ' ');
      console.log(`[apply-desc] + ${entry.normalized} → "${preview}..."`);
    }
  }

  console.log(`\n[apply-desc] ${dry ? 'Would apply' : 'Applied'}: ${applied} descriptions`);
  console.log(`[apply-desc] Skipped: ${skipped}`);

  if (!dry) {
    writeFileSync(seedPath, seedContent);
    console.log(`[apply-desc] ✓ Written to ${seedPath}`);
  } else {
    console.log('[apply-desc] Dry run complete — no files modified.');
  }
}

main();
