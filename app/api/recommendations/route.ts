import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — returns empty recommendations until M2.5 ships. */
export async function GET(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json([]);
}
