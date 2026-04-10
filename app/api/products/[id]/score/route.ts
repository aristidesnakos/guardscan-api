import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — personalized score endpoint not yet implemented. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  return NextResponse.json(
    { error: 'not_implemented', message: `Personalized score not yet available`, id },
    { status: 501 },
  );
}
