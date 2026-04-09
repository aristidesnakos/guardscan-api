import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — accepts push token registration, no-op until push is implemented. */
export async function POST(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ success: true });
}
