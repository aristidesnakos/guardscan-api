'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Submission = {
  id: string;
  barcode: string;
  status: string;
  confidence: number | null;
  createdAt: string;
  hasOcr: boolean;
};

const STATUS_OPTIONS = ['pending', 'in_review', 'published', 'rejected', 'all'] as const;

function getAdminId(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('guardscan_admin_id') || '';
}

function setAdminId(id: string) {
  localStorage.setItem('guardscan_admin_id', id);
}

function confidenceBadge(confidence: number | null) {
  if (confidence === null) return { label: 'OCR pending', bg: '#e9ecef', color: '#495057' };
  if (confidence >= 90) return { label: `${confidence}%`, bg: '#d4edda', color: '#155724' };
  if (confidence >= 70) return { label: `${confidence}%`, bg: '#fff3cd', color: '#856404' };
  return { label: `${confidence}%`, bg: '#f8d7da', color: '#721c24' };
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AdminSubmissionsPage() {
  const [adminId, setAdminIdState] = useState('');
  const [status, setStatus] = useState<string>('pending');
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAdminIdState(getAdminId());
  }, []);

  const fetchSubmissions = useCallback(async () => {
    const id = getAdminId();
    if (!id) {
      setError('Enter your admin user ID above');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/submissions?status=${status}&limit=50`, {
        headers: { 'X-Dev-User-Id': id },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSubmissions(data.submissions);
      setTotal(data.total);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (getAdminId()) fetchSubmissions();
  }, [fetchSubmissions]);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 40, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ marginBottom: 4 }}>Submission Review</h1>
        <Link href="/admin/calibration" style={{ color: '#0066cc', textDecoration: 'none', fontSize: 14 }}>
          Score Calibration →
        </Link>
      </div>
      <p style={{ color: '#6c757d', marginTop: 0, fontSize: 14 }}>Local dev only</p>

      {/* Admin ID bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 24, padding: 12, background: '#f5f5f5', borderRadius: 6 }}>
        <label style={{ fontSize: 14, fontWeight: 500 }}>Admin ID:</label>
        <input
          type="text"
          value={adminId}
          onChange={(e) => setAdminIdState(e.target.value)}
          placeholder="your-user-id"
          style={{ flex: 1, padding: '6px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14 }}
        />
        <button
          onClick={() => { setAdminId(adminId); fetchSubmissions(); }}
          style={{ padding: '6px 16px', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14 }}
        >
          Save & Refresh
        </button>
      </div>

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <label style={{ fontSize: 14, fontWeight: 500 }}>Status:</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14 }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
        <span style={{ fontSize: 13, color: '#6c757d' }}>
          {total} result{total !== 1 ? 's' : ''}
        </span>
      </div>

      {error && (
        <div style={{ padding: 12, background: '#f8d7da', color: '#721c24', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {loading && <p style={{ color: '#6c757d' }}>Loading...</p>}

      {!loading && submissions.length === 0 && !error && (
        <p style={{ color: '#6c757d' }}>No submissions found.</p>
      )}

      {submissions.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e0e0e0', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Barcode</th>
              <th style={{ padding: '8px 12px' }}>Confidence</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Submitted</th>
              <th style={{ padding: '8px 12px' }}></th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => {
              const badge = confidenceBadge(s.confidence);
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid #e0e0e0' }}>
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace' }}>{s.barcode}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 12, background: badge.bg, color: badge.color }}>
                      {badge.label}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>{s.status}</td>
                  <td style={{ padding: '10px 12px', color: '#6c757d' }}>{timeAgo(s.createdAt)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <Link
                      href={`/admin/submissions/${s.id}`}
                      style={{ color: '#0066cc', textDecoration: 'none', fontWeight: 500 }}
                    >
                      Review
                    </Link>
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
