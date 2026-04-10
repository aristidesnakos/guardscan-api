import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — toggle favorite is a no-op until favorites are implemented. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ is_favorite: false });
}
