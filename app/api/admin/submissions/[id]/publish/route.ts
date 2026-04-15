import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { userSubmissions } from '@/db/schema';
import { publishExtracted } from '@/lib/submissions/auto-publish';
import type { ProductCategory } from '@/types/guardscan';

const BLOCKED = NextResponse.json({ error: 'not_available' }, { status: 404 });
const VALID_CATEGORIES = ['food', 'grooming', 'supplement'] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV === 'production') return BLOCKED;

  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: { name?: string; brand?: string | null; category?: string; ingredients?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { name, brand, category, ingredients } = body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 });
  }
  if (!category || !VALID_CATEGORIES.includes(category as (typeof VALID_CATEGORIES)[number])) {
    return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
  }
  if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
    return NextResponse.json({ error: 'ingredients_required' }, { status: 400 });
  }

  try {
    const db = getDb();

    const [row] = await db
      .select({ id: userSubmissions.id, status: userSubmissions.status, barcode: userSubmissions.barcode })
      .from(userSubmissions)
      .where(eq(userSubmissions.id, id))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (row.status !== 'pending' && row.status !== 'in_review') {
      return NextResponse.json(
        { error: 'already_processed', status: row.status },
        { status: 409 },
      );
    }

    const reviewedBy = auth.userId ?? 'admin';

    const { productId, score } = await publishExtracted({
      submissionId: id,
      barcode: row.barcode,
      name: name.trim(),
      brand: brand?.trim() || null,
      category: category as ProductCategory,
      ingredients: ingredients.map((s) => s.trim()).filter(Boolean),
      reviewedBy,
    });

    return NextResponse.json({ ok: true, productId, score });
  } catch (err) {
    return NextResponse.json(
      { error: 'publish_failed', detail: String(err) },
      { status: 500 },
    );
  }
}
