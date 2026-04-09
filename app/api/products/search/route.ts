import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — returns empty search results until M4 ships. */
export async function POST(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ data: [], total: 0, limit: 20, offset: 0 });
}
