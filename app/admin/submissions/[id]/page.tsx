'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

type IngredientPreview = {
  name: string;
  position: number;
  flag: 'positive' | 'neutral' | 'caution' | 'negative';
  reason: string;
};

type SubmissionDetail = {
  id: string;
  barcode: string;
  userId: string;
  status: string;
  createdAt: string;
  reviewedBy: string | null;
  photos: { front: string | null; back: string | null };
  extracted: {
    name: string | null;
    brand: string | null;
    category: string | null;
    ingredients: string[];
    confidence: number;
    notes: string[];
  } | null;
  ingredientPreview: IngredientPreview[];
  duplicate: { exists: boolean; productId?: string; productName?: string };
};

const FLAG_COLORS: Record<string, { bg: string; color: string }> = {
  positive: { bg: '#d4edda', color: '#155724' },
  neutral: { bg: '#e9ecef', color: '#495057' },
  caution: { bg: '#fff3cd', color: '#856404' },
  negative: { bg: '#f8d7da', color: '#721c24' },
};

function getAdminId(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('guardscan_admin_id') || '';
}

function authHeaders(): Record<string, string> {
  const id = getAdminId();
  return id ? { 'X-Dev-User-Id': id } : {};
}

export default function AdminSubmissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable form fields
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [ingredientsText, setIngredientsText] = useState('');

  // Ingredient preview (can be refreshed independently)
  const [preview, setPreview] = useState<IngredientPreview[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Action states
  const [publishing, setPublishing] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/submissions/${id}`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const s: SubmissionDetail = data.submission;
      setSubmission(s);
      setName(s.extracted?.name ?? '');
      setBrand(s.extracted?.brand ?? '');
      setCategory(s.extracted?.category ?? '');
      setIngredientsText(s.extracted?.ingredients.join('\n') ?? '');
      setPreview(s.ingredientPreview);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const refreshPreview = async () => {
    const ingredients = ingredientsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ingredients.length === 0) return;

    setPreviewLoading(true);
    try {
      const encoded = encodeURIComponent(ingredients.join(','));
      const res = await fetch(
        `/api/admin/submissions/${id}?preview_ingredients=${encoded}`,
        { headers: authHeaders() },
      );
      if (res.ok) {
        const data = await res.json();
        setPreview(data.submission.ingredientPreview);
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const handlePublish = async () => {
    const ingredients = ingredientsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!name.trim()) { setError('Name is required'); return; }
    if (!['food', 'grooming', 'supplement'].includes(category)) { setError('Select a valid category'); return; }
    if (ingredients.length === 0) { setError('At least one ingredient is required'); return; }

    setPublishing(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/submissions/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name: name.trim(), brand: brand.trim() || null, category, ingredients }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult({ ok: true, message: `Published! Product ID: ${data.productId}, Score: ${data.score ?? 'n/a'}` });
      setSubmission((prev) => prev ? { ...prev, status: 'published' } : prev);
    } catch (err) {
      setResult({ ok: false, message: String(err instanceof Error ? err.message : err) });
    } finally {
      setPublishing(false);
    }
  };

  const handleReject = async () => {
    if (!rejectReason.trim()) { setError('Rejection reason is required'); return; }

    setRejecting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/submissions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult({ ok: true, message: 'Submission rejected.' });
      setSubmission((prev) => prev ? { ...prev, status: 'rejected' } : prev);
    } catch (err) {
      setResult({ ok: false, message: String(err instanceof Error ? err.message : err) });
    } finally {
      setRejecting(false);
    }
  };

  const isActionable = submission?.status === 'pending' || submission?.status === 'in_review';

  if (loading) {
    return (
      <main style={{ fontFamily: 'system-ui, sans-serif', padding: 40, maxWidth: 900, margin: '0 auto' }}>
        <p style={{ color: '#6c757d' }}>Loading...</p>
      </main>
    );
  }

  if (error && !submission) {
    return (
      <main style={{ fontFamily: 'system-ui, sans-serif', padding: 40, maxWidth: 900, margin: '0 auto' }}>
        <Link href="/admin/submissions" style={{ color: '#0066cc', textDecoration: 'none', fontSize: 14 }}>
          &larr; Back to queue
        </Link>
        <div style={{ padding: 12, background: '#f8d7da', color: '#721c24', borderRadius: 6, marginTop: 16 }}>
          {error}
        </div>
      </main>
    );
  }

  if (!submission) return null;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 40, maxWidth: 900, margin: '0 auto' }}>
      <Link href="/admin/submissions" style={{ color: '#0066cc', textDecoration: 'none', fontSize: 14 }}>
        &larr; Back to queue
      </Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 16 }}>
        <h1 style={{ marginBottom: 4 }}>Review Submission</h1>
        <span style={{
          padding: '4px 12px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 500,
          background: submission.status === 'published' ? '#d4edda'
            : submission.status === 'rejected' ? '#f8d7da'
            : '#fff3cd',
          color: submission.status === 'published' ? '#155724'
            : submission.status === 'rejected' ? '#721c24'
            : '#856404',
        }}>
          {submission.status}
        </span>
      </div>

      <p style={{ color: '#6c757d', marginTop: 0, fontSize: 14 }}>
        Barcode: <code>{submission.barcode}</code> &middot; {new Date(submission.createdAt).toLocaleString()}
      </p>

      {/* Result banner */}
      {result && (
        <div style={{
          padding: 12,
          borderRadius: 6,
          marginBottom: 16,
          background: result.ok ? '#d4edda' : '#f8d7da',
          color: result.ok ? '#155724' : '#721c24',
          fontSize: 14,
        }}>
          {result.message}
        </div>
      )}

      {error && (
        <div style={{ padding: 12, background: '#f8d7da', color: '#721c24', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Duplicate warning */}
      {submission.duplicate.exists && (
        <div style={{ padding: 12, background: '#fff3cd', color: '#856404', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          Barcode already exists in catalog: {submission.duplicate.productName} ({submission.duplicate.productId})
        </div>
      )}

      {/* Photos */}
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Photos</h2>
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {submission.photos.front ? (
          <img
            src={submission.photos.front}
            alt="Front label"
            style={{ maxWidth: '48%', maxHeight: 400, objectFit: 'contain', borderRadius: 6, border: '1px solid #e0e0e0' }}
          />
        ) : (
          <div style={{ width: '48%', height: 200, background: '#f5f5f5', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14 }}>
            No front photo
          </div>
        )}
        {submission.photos.back ? (
          <img
            src={submission.photos.back}
            alt="Back label"
            style={{ maxWidth: '48%', maxHeight: 400, objectFit: 'contain', borderRadius: 6, border: '1px solid #e0e0e0' }}
          />
        ) : (
          <div style={{ width: '48%', height: 200, background: '#f5f5f5', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14 }}>
            No back photo
          </div>
        )}
      </div>

      {/* OCR info */}
      {submission.extracted && (
        <p style={{ fontSize: 13, color: '#6c757d', marginBottom: 4 }}>
          OCR confidence: <strong>{submission.extracted.confidence}%</strong>
          {submission.extracted.notes.length > 0 && (
            <> &middot; Notes: {submission.extracted.notes.join(', ')}</>
          )}
        </p>
      )}

      {!submission.extracted && (
        <div style={{ padding: 12, background: '#e9ecef', borderRadius: 6, marginBottom: 16, fontSize: 14, color: '#495057' }}>
          OCR not yet complete. Refresh in a moment.
        </div>
      )}

      {/* Edit form */}
      {isActionable && (
        <>
          <h2 style={{ fontSize: 16, marginBottom: 8, marginTop: 24 }}>Product Details</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Brand</label>
              <input
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Category *</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14 }}
            >
              <option value="">-- select --</option>
              <option value="food">Food</option>
              <option value="grooming">Grooming</option>
              <option value="supplement">Supplement</option>
            </select>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Ingredients (one per line) *</label>
            <textarea
              value={ingredientsText}
              onChange={(e) => setIngredientsText(e.target.value)}
              rows={8}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }}
            />
          </div>

          <button
            onClick={refreshPreview}
            disabled={previewLoading}
            style={{ padding: '6px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer', fontSize: 13, marginBottom: 16 }}
          >
            {previewLoading ? 'Refreshing...' : 'Refresh Flag Preview'}
          </button>
        </>
      )}

      {/* Ingredient flag preview */}
      {preview.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, marginBottom: 8, marginTop: isActionable ? 8 : 24 }}>Ingredient Flags</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginBottom: 24 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e0e0e0', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px', width: 40 }}>#</th>
                <th style={{ padding: '6px 10px' }}>Ingredient</th>
                <th style={{ padding: '6px 10px', width: 90 }}>Flag</th>
                <th style={{ padding: '6px 10px' }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((ing) => {
                const fc = FLAG_COLORS[ing.flag] || FLAG_COLORS.neutral;
                return (
                  <tr key={ing.position} style={{ borderBottom: '1px solid #e0e0e0' }}>
                    <td style={{ padding: '6px 10px', color: '#999' }}>{ing.position}</td>
                    <td style={{ padding: '6px 10px' }}>{ing.name}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 12, background: fc.bg, color: fc.color }}>
                        {ing.flag}
                      </span>
                    </td>
                    <td style={{ padding: '6px 10px', color: '#6c757d', fontSize: 13 }}>{ing.reason || '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {/* Actions */}
      {isActionable && (
        <div style={{ borderTop: '1px solid #e0e0e0', paddingTop: 20, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={handlePublish}
              disabled={publishing}
              style={{ padding: '10px 24px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 500 }}
            >
              {publishing ? 'Publishing...' : 'Publish'}
            </button>
            <button
              onClick={() => setShowReject(!showReject)}
              style={{ padding: '10px 24px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 500 }}
            >
              Reject
            </button>
          </div>

          {showReject && (
            <div style={{ marginTop: 12 }}>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Rejection reason..."
                rows={3}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }}
              />
              <button
                onClick={handleReject}
                disabled={rejecting}
                style={{ padding: '8px 20px', background: '#721c24', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
              >
                {rejecting ? 'Rejecting...' : 'Confirm Reject'}
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
