/**
 * M1 auth: accept either a dev header (X-Dev-User-Id) or a Bearer token.
 * In M1 we do NOT verify the JWT signature — that is a follow-up milestone
 * before the backend is exposed publicly. The route handler calls
 * `requireUser` to fail closed when AUTH_ENABLED=true and neither is present.
 */

import { NextResponse } from 'next/server';

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

export type AuthContext = {
  userId: string | null;
  source: 'dev' | 'bearer' | 'anonymous';
};

export function extractAuth(request: Request): AuthContext {
  const devId = request.headers.get('x-dev-user-id');
  if (devId) return { userId: devId, source: 'dev' };

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // TODO(M1.5): verify against Supabase JWT secret before production exposure.
    return { userId: 'unverified', source: 'bearer' };
  }

  return { userId: null, source: 'anonymous' };
}

export function requireUser(request: Request): AuthContext | NextResponse {
  const ctx = extractAuth(request);
  if (!AUTH_ENABLED) return ctx;
  if (ctx.userId) return ctx;
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
