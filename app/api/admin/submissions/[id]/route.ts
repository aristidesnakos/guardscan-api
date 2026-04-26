import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { userSubmissions, products } from '@/db/schema';
import { resolveImageUrl } from '@/lib/storage/supabase';
import { lookupIngredient } from '@/lib/dictionary/lookup';
import { normalizeIngredientName } from '@/lib/dictionary/resolve';

type PhotoEntry = { role: string; path: string };

const BLOCKED = NextResponse.json({ error: 'not_available' }, { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV === 'production') return BLOCKED;

  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const db = getDb();

    const [row] = await db
      .select()
      .from(userSubmissions)
      .where(eq(userSubmissions.id, id))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Signed photo URLs
    const photos = row.photos as PhotoEntry[];
    let frontUrl: string | null = null;
    let backUrl: string | null = null;
    try {
      const frontPhoto = photos.find((p) => p.role === 'front');
      const backPhoto = photos.find((p) => p.role === 'back');
      if (frontPhoto) frontUrl = resolveImageUrl(frontPhoto.path);
      if (backPhoto) backUrl = resolveImageUrl(backPhoto.path);
    } catch {
      // Storage not configured — leave URLs null
    }

    // Parse OCR
    const extracted = row.ocrText
      ? (JSON.parse(row.ocrText) as {
          name: string | null;
          brand: string | null;
          category: string | null;
          ingredients: string[];
          confidence: number;
          notes: string[];
        })
      : null;

    // Ingredient flag preview — use query param override if provided
    const url = new URL(request.url);
    const previewParam = url.searchParams.get('preview_ingredients');
    const ingredientsForPreview = previewParam
      ? previewParam.split(',').map((s) => s.trim()).filter(Boolean)
      : extracted?.ingredients ?? [];

    const ingredientPreview = ingredientsForPreview.map((name, i) => {
      const entry = lookupIngredient(normalizeIngredientName(name));
      return {
        name,
        position: i + 1,
        flag: entry?.flag ?? 'neutral',
        reason: entry?.reason ?? '',
      };
    });

    // Duplicate check
    const [existing] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.barcode, row.barcode))
      .limit(1);

    return NextResponse.json({
      submission: {
        id: row.id,
        barcode: row.barcode,
        userId: row.userId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        reviewedBy: row.reviewedBy,
        photos: { front: frontUrl, back: backUrl },
        extracted,
        ingredientPreview,
        duplicate: existing
          ? { exists: true, productId: existing.id, productName: existing.name }
          : { exists: false },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}
