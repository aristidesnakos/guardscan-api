import { NextResponse } from 'next/server';
import { eq, inArray, asc, desc } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { products, productIngredients } from '@/db/schema';

const BLOCKED = NextResponse.json({ error: 'not_available' }, { status: 404 });

export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') return BLOCKED;

  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const category = url.searchParams.get('category') || 'grooming';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

  const validCategories = ['food', 'grooming', 'supplement'] as const;
  const cat = validCategories.includes(category as (typeof validCategories)[number])
    ? (category as (typeof validCategories)[number])
    : 'grooming';

  try {
    const db = getDb();

    const productRows = await db
      .select()
      .from(products)
      .where(eq(products.category, cat))
      .orderBy(desc(products.createdAt))
      .limit(limit);

    if (productRows.length === 0) {
      return NextResponse.json({ products: [], total: 0 });
    }

    const productIds = productRows.map((r) => r.id);

    const ingredientRows = await db
      .select()
      .from(productIngredients)
      .where(inArray(productIngredients.productId, productIds))
      .orderBy(asc(productIngredients.position));

    // Group by product id in memory — avoids N+1
    const ingsByProduct = new Map<string, typeof ingredientRows>();
    for (const ing of ingredientRows) {
      const list = ingsByProduct.get(ing.productId) ?? [];
      list.push(ing);
      ingsByProduct.set(ing.productId, list);
    }

    const result = productRows.map((row) => {
      const ings = ingsByProduct.get(row.id) ?? [];
      const flagged = ings
        .filter((ing) => ing.flag === 'caution' || ing.flag === 'negative')
        .map((ing) => ({
          name: ing.name,
          position: ing.position,
          flag: ing.flag as 'caution' | 'negative',
        }));

      return {
        id: row.id,
        barcode: row.barcode,
        name: row.name,
        brand: row.brand ?? null,
        category: row.category,
        subcategory: row.subcategory ?? null,
        score: row.score ?? null,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
        flaggedIngredients: flagged,
      };
    });

    return NextResponse.json({ products: result, total: result.length });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}
