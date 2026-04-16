/**
 * Phase 0 — Ingredient Source Verification Script
 *
 * Verifies that PubChem PUG View and PubMed E-utilities APIs return
 * the structured data needed for the ingredient enrichment proposal.
 *
 * Runs 3 sample ingredients (1 per category) against both APIs and
 * outputs a pass/fail report. No DB access, no env vars needed.
 *
 * Usage: npx tsx scripts/audit-ingredient-sources.ts
 */

export {};

// ── H-Code → GuardScan risk tag mapping ─────────────────────────────────────

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

// ── Sample ingredients ──────────────────────────────────────────────────────

type SampleIngredient = {
  name: string;
  /** Scientific / IUPAC name to try if common name fails on PubChem. */
  pubchemFallback?: string;
  category: string;
  pmid: string;
};

const SAMPLES: SampleIngredient[] = [
  { name: 'sodium lauryl sulfate', category: 'grooming', pmid: '26617461' },
  { name: 'aspartame', category: 'food', pmid: '23891579' },
  { name: 'ashwagandha', pubchemFallback: 'withaferin A', category: 'supplement', pmid: '23439798' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function log(msg: string) {
  console.log(`[audit] ${msg}`);
}

// ── PubChem checks ──────────────────────────────────────────────────────────

type PubChemResult = {
  pass: boolean;
  cid: number | null;
  hCodes: string[];
  tags: string[];
  error?: string;
};

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

async function checkPubChem(ingredientName: string, fallbackName?: string): Promise<PubChemResult> {
  // Step 1: Resolve name → CID (try fallback if primary fails)
  log(`  PubChem: resolving "${ingredientName}" → CID...`);
  let resolved = await resolveCID(ingredientName);

  if (!resolved.cid && fallbackName) {
    log(`  PubChem: primary name failed, trying "${fallbackName}"...`);
    await delay(200);
    resolved = await resolveCID(fallbackName);
  }

  const cid = resolved.cid;
  if (!cid) {
    return { pass: false, cid: null, hCodes: [], tags: [], error: `CID lookup failed: ${resolved.error}` };
  }

  log(`  PubChem: CID ${cid} — fetching GHS data...`);
  await delay(200);

  // Step 2: Fetch GHS hazard data
  const ghsUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON?heading=Safety+and+Hazards`;
  try {
    const ghsRes = await fetch(ghsUrl, { signal: AbortSignal.timeout(15_000) });
    if (!ghsRes.ok) {
      return { pass: false, cid, hCodes: [], tags: [], error: `GHS fetch failed: HTTP ${ghsRes.status}` };
    }
    const ghsData = await ghsRes.json();

    // Walk the nested Section structure to find GHS Hazard Statements
    const { mapped, all } = extractHCodes(ghsData);
    const tags = [...new Set(mapped.map((h) => H_CODE_TO_TAG[h]).filter(Boolean))];

    log(`  PubChem: found ${all.length} H-codes (${mapped.length} mapped) → tags: ${tags.join(', ') || '(none)'}`);
    // PASS if CID resolved and GHS data was returned (even without mapped H-codes,
    // the CID alone is valuable for linking — e.g. approved food additives).
    return { pass: true, cid, hCodes: mapped, tags };
  } catch (err) {
    return { pass: false, cid, hCodes: [], tags: [], error: `GHS fetch error: ${err}` };
  }
}

type HCodeResult = { mapped: string[]; all: string[] };

function extractHCodes(data: unknown): HCodeResult {
  const json = JSON.stringify(data);
  const mapped: string[] = [];
  const all: string[] = [];

  // Match H-codes in the format "H302", "H315", etc.
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

// ── PubMed checks ───────────────────────────────────────────────────────────

type PubMedResult = {
  pass: boolean;
  title: string | null;
  abstractLength: number;
  publicationType: string | null;
  error?: string;
};

async function checkPubMed(pmid: string): Promise<PubMedResult> {
  log(`  PubMed: fetching PMID ${pmid}...`);

  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { pass: false, title: null, abstractLength: 0, publicationType: null, error: `HTTP ${res.status}` };
    }
    const xml = await res.text();

    // Extract title (between <ArticleTitle> tags)
    const titleMatch = xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    const title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() ?? null;

    // Extract abstract text (between <AbstractText> tags — may be multiple)
    const abstractMatches = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
    let abstractText = '';
    if (abstractMatches) {
      abstractText = abstractMatches
        .map((m) => m.replace(/<[^>]+>/g, '').trim())
        .join(' ');
    }

    // Extract publication type
    const pubTypeMatch = xml.match(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/);
    const publicationType = pubTypeMatch?.[1]?.trim() ?? null;

    if (title) {
      const shortTitle = title.length > 70 ? title.slice(0, 70) + '...' : title;
      log(`  PubMed: title="${shortTitle}"`);
    }
    log(`  PubMed: abstract present (${abstractText.length} chars)`);

    return {
      pass: !!title && abstractText.length > 50,
      title,
      abstractLength: abstractText.length,
      publicationType,
    };
  } catch (err) {
    return { pass: false, title: null, abstractLength: 0, publicationType: null, error: `Fetch error: ${err}` };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

type AuditResult = {
  ingredient: SampleIngredient;
  pubchem: PubChemResult;
  pubmed: PubMedResult;
};

async function main() {
  log('Ingredient Source Verification — Phase 0');
  log('═══════════════════════════════════════════════\n');

  const results: AuditResult[] = [];

  for (let i = 0; i < SAMPLES.length; i++) {
    const sample = SAMPLES[i];
    log(`${i + 1}/${SAMPLES.length}  ${sample.name} (${sample.category})`);

    const pubchem = await checkPubChem(sample.name, sample.pubchemFallback);
    if (pubchem.error) {
      log(`  ✗ PubChem FAIL — ${pubchem.error}`);
    } else {
      log(`  ${pubchem.pass ? '✓' : '✗'} PubChem ${pubchem.pass ? 'PASS' : 'FAIL'}`);
    }

    await delay(200);

    const pubmed = await checkPubMed(sample.pmid);
    if (pubmed.error) {
      log(`  ✗ PubMed FAIL — ${pubmed.error}`);
    } else {
      log(`  ${pubmed.pass ? '✓' : '✗'} PubMed ${pubmed.pass ? 'PASS' : 'FAIL'}`);
    }

    results.push({ ingredient: sample, pubchem, pubmed });

    if (i < SAMPLES.length - 1) {
      log('');
      await delay(300);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  log('\n═══════════════════════════════════════════════');
  log('Summary\n');

  const nameWidth = 28;
  log(`  ${'Ingredient'.padEnd(nameWidth)} PubChem   PubMed`);
  for (const r of results) {
    const name = r.ingredient.name.padEnd(nameWidth);
    const pc = r.pubchem.pass ? 'PASS' : 'FAIL';
    const pm = r.pubmed.pass ? 'PASS' : 'FAIL';
    log(`  ${name} ${pc.padEnd(10)}${pm}`);
  }

  const pubchemPassed = results.filter((r) => r.pubchem.pass).length;
  const total = results.length;
  const goNoGo = pubchemPassed >= 2 ? 'PASS' : 'FAIL';

  log('');
  log(`Go/no-go: ${goNoGo} (${pubchemPassed}/${total} PubChem checks passed)`);

  if (goNoGo === 'FAIL') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[audit] Fatal error:', err);
  process.exit(1);
});
