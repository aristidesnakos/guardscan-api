import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';

/** Stub — product-by-ID lookup not yet implemented. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  return NextResponse.json(
    { error: 'not_implemented', message: `Product lookup by ID not yet available`, id },
    { status: 501 },
  );
}
