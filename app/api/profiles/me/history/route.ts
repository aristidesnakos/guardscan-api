import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — returns empty history until history endpoints are implemented. */
export async function GET(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ data: [], total: 0, limit: 20, offset: 0 });
}
