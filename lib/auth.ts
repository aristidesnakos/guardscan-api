/**
 * Auth helpers for route handlers.
 *
 * Default behaviour: auth IS enforced. Set AUTH_ENABLED=false to bypass
 * (dev / CI only — never set this in a production environment).
 *
 * Bearer JWT is verified against SUPABASE_JWT_SECRET (HS256) using the
 * built-in Web Crypto API — no extra dependencies required.
 *
 * X-Dev-User-Id is only accepted when ALLOW_DEV_AUTH=true.
 * Never set ALLOW_DEV_AUTH=true in production.
 */

import { NextResponse } from 'next/server';

// Explicit opt-out is the ONLY way to disable auth checks.
// Anything other than 'false' (including unset) enforces auth.
const AUTH_DISABLED = process.env.AUTH_ENABLED === 'false';
const DEV_AUTH_ALLOWED = process.env.ALLOW_DEV_AUTH === 'true';

export type AuthContext = {
  userId: string | null;
  source: 'dev' | 'bearer' | 'anonymous';
};

/** Verify a Supabase HS256 JWT using the Web Crypto API. */
async function verifyJwt(token: string): Promise<{ sub: string } | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const sigBytes = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { sub?: string; exp?: number };

    if (!payload.sub) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export async function extractAuth(request: Request): Promise<AuthContext> {
  if (DEV_AUTH_ALLOWED) {
    const devId = request.headers.get('x-dev-user-id');
    if (devId) return { userId: devId, source: 'dev' };
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const payload = await verifyJwt(authHeader.slice(7));
    if (payload) return { userId: payload.sub, source: 'bearer' };
  }

  return { userId: null, source: 'anonymous' };
}

export async function requireUser(
  request: Request,
): Promise<AuthContext | NextResponse> {
  if (AUTH_DISABLED) {
    return { userId: null, source: 'anonymous' };
  }
  const ctx = await extractAuth(request);
  if (ctx.userId) return ctx;
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function requireAdmin(
  request: Request,
): Promise<AuthContext | NextResponse> {
  const result = await requireUser(request);
  if (result instanceof NextResponse) return result;
  if (!result.userId || !ADMIN_IDS.includes(result.userId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return result;
}
