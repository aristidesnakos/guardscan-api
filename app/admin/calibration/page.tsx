'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type FlaggedIngredient = {
  name: string;
  position: number;
  flag: 'caution' | 'negative';
};

type CalibrationProduct = {
  id: string;
  barcode: string;
  name: string;
  brand: string | null;
  category: string;
  subcategory: string | null;
  score: number | null;
  source: string;
  createdAt: string;
  flaggedIngredients: FlaggedIngredient[];
};

// ── Scoring helpers (mirrors backend constants) ──────────────────────────────

const RATING_BANDS = [
  { min: 80, label: 'Excellent', color: '#16A34A', bg: '#d4edda' },
  { min: 60, label: 'Good',      color: '#65A30D', bg: '#eaf5d0' },
  { min: 40, label: 'Mediocre',  color: '#EA580C', bg: '#fff0e6' },
  { min: 0,  label: 'Poor',      color: '#DC2626', bg: '#f8d7da' },
];

function getRating(score: number) {
  for (const band of RATING_BANDS) {
    if (score >= band.min) return band;
  }
  return RATING_BANDS[3];
}

const FLAG_STYLE: Record<string, { bg: string; color: string }> = {
  negative: { bg: '#f8d7da', color: '#721c24' },
  caution:  { bg: '#fff3cd', color: '#856404' },
};

function gapStyle(gap: number): { color: string; bg: string } {
  const abs = Math.abs(gap);
  if (abs <= 5)  return { color: '#155724', bg: '#d4edda' };
  if (abs <= 15) return { color: '#856404', bg: '#fff3cd' };
  return { color: '#721c24', bg: '#f8d7da' };
}

// ── localStorage persistence ─────────────────────────────────────────────────

const SCORES_KEY = 'guardscan_calibration_scores';

function loadYukaScores(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveYukaScores(scores: Record<string, number>) {
  localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
}

// ── Auth helpers (matches other admin pages) ─────────────────────────────────

function getAdminId(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('guardscan_admin_id') || '';
}

function authHeaders(): Record<string, string> {
  const id = getAdminId();
  return id ? { 'X-Dev-User-Id': id } : {};
}

// ── Component ────────────────────────────────────────────────────────────────

const CATEGORIES = ['grooming', 'food', 'supplement'] as const;
const SOURCE_FILTERS = [
  { value: 'all',     label: 'All sources' },
  { value: 'user',    label: 'User submissions' },
  { value: 'catalog', label: 'Catalog' },
] as const;

export default function CalibrationPage() {
  const [category, setCategory]       = useState<string>('grooming');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'user' | 'catalog'>('all');
  const [products, setProducts]       = useState<CalibrationProduct[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [yukaScores, setYukaScores]   = useState<Record<string, number>>({});

  // Hydrate Yuka scores from localStorage on mount
  useEffect(() => {
    setYukaScores(loadYukaScores());
  }, []);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/calibration?category=${category}`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setProducts(data.products);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // ── Yuka score handlers ────────────────────────────────────────────────────

  const setYukaScore = (productId: string, value: number | null) => {
    setYukaScores((prev) => {
      const next = { ...prev };
      if (value === null) {
        delete next[productId];
      } else {
        next[productId] = value;
      }
      saveYukaScores(next);
      return next;
    });
  };

  // ── Derived data ───────────────────────────────────────────────────────────

  const filtered = products.filter((p) => {
    if (sourceFilter === 'user')    return p.source === 'user';
    if (sourceFilter === 'catalog') return p.source !== 'user';
    return true;
  });

  const scored = filtered.filter((p) => p.score != null && yukaScores[p.id] != null);
  const avgGap = scored.length > 0
    ? scored.reduce((sum, p) => sum + (p.score! - yukaScores[p.id]), 0) / scored.length
    : null;

  // ── CSV export ─────────────────────────────────────────────────────────────

  const exportCsv = () => {
    const header = 'barcode,name,brand,subcategory,mangood_score,yuka_score,gap,flagged_ingredients,source';
    const rows = filtered.map((p) => {
      const mangood = p.score ?? '';
      const yuka    = yukaScores[p.id] ?? '';
      const gap     = p.score != null && yuka !== '' ? p.score - (yuka as number) : '';
      const flags   = p.flaggedIngredients
        .map((f) => `${f.name}(${f.flag[0].toUpperCase()})`)
        .join('; ');
      return [
        p.barcode,
        `"${p.name.replace(/"/g, '""')}"`,
        p.brand ? `"${p.brand.replace(/"/g, '""')}"` : '',
        p.subcategory ?? '',
        mangood,
        yuka,
        gap,
        `"${flags}"`,
        p.source,
      ].join(',');
    });

    const csv  = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `calibration-${category}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 40, maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <Link
            href="/admin/submissions"
            style={{ color: '#0066cc', textDecoration: 'none', fontSize: 14 }}
          >
            ← Submissions
          </Link>
          <h1 style={{ margin: '8px 0 4px' }}>Score Calibration</h1>
          <p style={{ color: '#6c757d', fontSize: 14, margin: 0 }}>
            Enter Yuka scores to compare against ManGood. Scores are saved in this browser.
          </p>
        </div>
        <button
          onClick={exportCsv}
          style={{
            padding: '8px 18px',
            background: '#0066cc',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Export CSV
        </button>
      </div>

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>

        {/* Category tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              style={{
                padding: '6px 14px',
                borderRadius: 4,
                border: '1px solid #ddd',
                cursor: 'pointer',
                fontSize: 13,
                background: category === cat ? '#0066cc' : '#fff',
                color:      category === cat ? '#fff'    : '#333',
                fontWeight: category === cat ? 600       : 400,
              }}
            >
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          ))}
        </div>

        {/* Source tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {SOURCE_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setSourceFilter(value)}
              style={{
                padding: '6px 14px',
                borderRadius: 4,
                border: '1px solid #ddd',
                cursor: 'pointer',
                fontSize: 13,
                background: sourceFilter === value ? '#495057' : '#fff',
                color:      sourceFilter === value ? '#fff'    : '#333',
                fontWeight: sourceFilter === value ? 600       : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Summary badge */}
        {avgGap !== null && (
          <div style={{ marginLeft: 'auto', fontSize: 13, color: '#6c757d' }}>
            avg gap{' '}
            <strong style={{ color: gapStyle(avgGap).color }}>
              {avgGap > 0 ? '+' : ''}{avgGap.toFixed(1)}
            </strong>
            {' '}across{' '}
            <strong>{scored.length}</strong> scored
            {filtered.length > scored.length && (
              <span style={{ color: '#adb5bd' }}> · {filtered.length - scored.length} pending</span>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: 12, background: '#f8d7da', color: '#721c24', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Loading / empty */}
      {loading ? (
        <p style={{ color: '#6c757d' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: '#6c757d' }}>No {category} products found.</p>
      ) : (

        /* Table */
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #dee2e6', background: '#f8f9fa', textAlign: 'left' }}>
              <th style={{ padding: '10px 12px' }}>Product</th>
              <th style={{ padding: '10px 12px', width: 110 }}>Subcategory</th>
              <th style={{ padding: '10px 12px' }}>Flagged ingredients</th>
              <th style={{ padding: '10px 12px', width: 120, textAlign: 'center' }}>ManGood</th>
              <th style={{ padding: '10px 12px', width: 100, textAlign: 'center' }}>Yuka</th>
              <th style={{ padding: '10px 12px', width: 80,  textAlign: 'center' }}>Gap</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const yukaScore = yukaScores[p.id] ?? null;
              const gap       = p.score != null && yukaScore != null ? p.score - yukaScore : null;
              const rating    = p.score != null ? getRating(p.score) : null;

              return (
                <tr key={p.id} style={{ borderBottom: '1px solid #e9ecef' }}>

                  {/* Product */}
                  <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    {p.brand && (
                      <div style={{ color: '#6c757d', fontSize: 12 }}>{p.brand}</div>
                    )}
                    <div style={{ fontSize: 11, marginTop: 3, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <code style={{ color: '#adb5bd', background: '#f8f9fa', padding: '1px 5px', borderRadius: 3 }}>
                        {p.barcode}
                      </code>
                      {p.source === 'user' && (
                        <span style={{ color: '#0066cc', fontSize: 11 }}>user submission</span>
                      )}
                    </div>
                  </td>

                  {/* Subcategory */}
                  <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
                    {p.subcategory ? (
                      <span style={{
                        padding: '2px 8px',
                        background: '#e9ecef',
                        borderRadius: 10,
                        fontSize: 12,
                        color: '#495057',
                      }}>
                        {p.subcategory}
                      </span>
                    ) : (
                      <span style={{ color: '#ced4da', fontSize: 12 }}>—</span>
                    )}
                  </td>

                  {/* Flagged ingredients */}
                  <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
                    {p.flaggedIngredients.length === 0 ? (
                      <span style={{ color: '#ced4da', fontSize: 12 }}>none</span>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {p.flaggedIngredients.map((f) => {
                          const s = FLAG_STYLE[f.flag];
                          return (
                            <span
                              key={`${f.position}-${f.name}`}
                              title={`#${f.position} — ${f.flag}`}
                              style={{
                                padding: '2px 7px',
                                borderRadius: 10,
                                fontSize: 11,
                                background: s.bg,
                                color: s.color,
                                cursor: 'default',
                              }}
                            >
                              {f.name}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </td>

                  {/* ManGood score */}
                  <td style={{ padding: '10px 12px', verticalAlign: 'top', textAlign: 'center' }}>
                    {rating ? (
                      <div>
                        <span style={{
                          display: 'inline-block',
                          padding: '5px 14px',
                          borderRadius: 6,
                          background: rating.bg,
                          color: rating.color,
                          fontWeight: 700,
                          fontSize: 18,
                          lineHeight: 1,
                        }}>
                          {p.score}
                        </span>
                        <div style={{ fontSize: 11, color: rating.color, marginTop: 4 }}>
                          {rating.label}
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: '#ced4da', fontSize: 12 }}>not scored</span>
                    )}
                  </td>

                  {/* Yuka score input */}
                  <td style={{ padding: '10px 12px', verticalAlign: 'top', textAlign: 'center' }}>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      placeholder="—"
                      value={yukaScore ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === '') {
                          setYukaScore(p.id, null);
                        } else {
                          const n = Math.max(0, Math.min(100, Number(raw)));
                          setYukaScore(p.id, n);
                        }
                      }}
                      style={{
                        width: 64,
                        padding: '6px 8px',
                        border: `1px solid ${yukaScore != null ? '#adb5bd' : '#ddd'}`,
                        borderRadius: 4,
                        fontSize: 14,
                        textAlign: 'center',
                        fontWeight: yukaScore != null ? 600 : 400,
                        color: yukaScore != null ? '#212529' : '#adb5bd',
                      }}
                    />
                  </td>

                  {/* Gap */}
                  <td style={{ padding: '10px 12px', verticalAlign: 'top', textAlign: 'center' }}>
                    {gap !== null ? (
                      <span style={{
                        display: 'inline-block',
                        padding: '4px 10px',
                        borderRadius: 6,
                        fontSize: 14,
                        fontWeight: 700,
                        ...gapStyle(gap),
                      }}>
                        {gap > 0 ? '+' : ''}{gap}
                      </span>
                    ) : (
                      <span style={{ color: '#ced4da', fontSize: 12 }}>—</span>
                    )}
                  </td>

                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
