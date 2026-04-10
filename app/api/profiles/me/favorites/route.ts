import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — returns empty favorites until favorites endpoints are implemented. */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json([]);
}
