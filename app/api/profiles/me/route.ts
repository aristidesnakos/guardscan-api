import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import type { UserProfile } from '@/types/guardscan';

const DEFAULT_PROFILE: UserProfile = {
  id: 'stub-profile',
  user_id: 'stub-user',
  age: null,
  life_stage: 'general_wellness',
  trying_to_conceive: false,
  allergens: [],
  dietary_approach: 'standard',
};

/** Stub — returns a default profile until profile endpoints are implemented. */
export async function GET(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json(DEFAULT_PROFILE);
}

/** Stub — accepts profile updates and echoes them back merged with defaults. */
export async function PUT(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  return NextResponse.json({ ...DEFAULT_PROFILE, ...body });
}
