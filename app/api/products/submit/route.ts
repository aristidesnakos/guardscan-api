import { after, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { products, userSubmissions } from '@/db/schema';
import { uploadSubmissionPhoto } from '@/lib/storage/supabase';
import { extractSubmissionWithClaude } from '@/lib/ocr/claude-vision';
import { log } from '@/lib/logger';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;
  if (!auth.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const barcode = String(formData.get('barcode') ?? '').trim();
  const front = formData.get('front');
  const back = formData.get('back');

  if (!barcode || !(front instanceof File) || !(back instanceof File)) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'barcode, front, back required' },
      { status: 400 },
    );
  }
  for (const file of [front, back]) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json({ error: 'unsupported_type' }, { status: 415 });
    }
  }

  const db = getDb();

  // Short-circuit: product already in catalog
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.barcode, barcode))
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({
      status: 'already_in_catalog',
      product_id: existing[0].id,
      message: 'This product is already in our database.',
    });
  }

  const submissionId = randomUUID();

  await db.insert(userSubmissions).values({
    id: submissionId,
    userId: auth.userId,
    barcode,
    photos: [],
    status: 'pending',
  });

  const [frontPath, backPath] = await Promise.all([
    uploadSubmissionPhoto(submissionId, 'front', front),
    uploadSubmissionPhoto(submissionId, 'back', back),
  ]);

  await db
    .update(userSubmissions)
    .set({
      photos: [
        { role: 'front', path: frontPath },
        { role: 'back', path: backPath },
      ],
    })
    .where(eq(userSubmissions.id, submissionId));

  log.info('submission_received', {
    submission_id: submissionId,
    barcode,
    user_id: auth.userId,
  });

  // OCR runs after response — never block the upload
  after(async () => {
    try {
      const extracted = await extractSubmissionWithClaude({ frontPath, backPath });
      await db
        .update(userSubmissions)
        .set({ ocrText: JSON.stringify(extracted) })
        .where(eq(userSubmissions.id, submissionId));
      log.info('submission_ocr_complete', {
        submission_id: submissionId,
        confidence: extracted.confidence,
      });
    } catch (err) {
      log.warn('submission_ocr_failed', {
        submission_id: submissionId,
        error: String(err),
      });
    }
  });

  return NextResponse.json(
    {
      submission_id: submissionId,
      status: 'pending_review',
      message: "Thank you! We'll review your submission within 24 hours.",
    },
    { status: 201 },
  );
}
