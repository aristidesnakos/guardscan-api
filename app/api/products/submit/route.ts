import { NextResponse } from 'next/server';

export const maxDuration = 60; // OCR runs inline — needs headroom for the Claude Vision call
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { products, productIngredients, userSubmissions } from '@/db/schema';
import { uploadSubmissionPhoto } from '@/lib/storage/supabase';
import {
  extractSubmissionWithClaude,
  type ExtractedSubmission,
} from '@/lib/ocr/claude-vision';
import {
  tryAutoPublish,
  type AutoPublishResult,
} from '@/lib/submissions/auto-publish';
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

  // Short-circuit: product already in catalog WITH ingredients.
  // Products cached from OFF/OBF without ingredients are "partial" —
  // allow user submissions to enrich them via the normal OCR + auto-publish path.
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.barcode, barcode))
    .limit(1);
  if (existing.length > 0) {
    const hasIngredients = await db
      .select({ productId: productIngredients.productId })
      .from(productIngredients)
      .where(eq(productIngredients.productId, existing[0].id))
      .limit(1);
    if (hasIngredients.length > 0) {
      return NextResponse.json({
        status: 'already_in_catalog',
        product_id: existing[0].id,
        message: 'This product is already in our database.',
      });
    }
    // Product exists but lacks ingredients — allow enrichment submission
    log.info('submission_enrichment', {
      barcode,
      existing_product_id: existing[0].id,
      user_id: auth.userId,
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

  // OCR runs inline — after() silently no-ops on this Vercel deployment
  // (waitUntil not provided). maxDuration=60 gives headroom for the Claude
  // Vision call plus the auto-publish upsert that follows.
  let extracted: ExtractedSubmission | null = null;
  try {
    extracted = await extractSubmissionWithClaude({ frontPath, backPath });
    await db
      .update(userSubmissions)
      .set({ ocrText: JSON.stringify(extracted) })
      .where(eq(userSubmissions.id, submissionId));
    log.info('submission_ocr_complete', {
      submission_id: submissionId,
      confidence: extracted.confidence,
    });
  } catch (err) {
    // Non-fatal — submission is saved, admin can review photos manually
    log.warn('submission_ocr_failed', {
      submission_id: submissionId,
      error: String(err),
    });
  }

  // ── M3.1 auto-publish ──────────────────────────────────────────────────
  // If OCR succeeded and Claude met the confidence + guardrails bar, this
  // promotes the submission straight into the `products` table with
  // source='user'. Skipped / failed submissions stay `status='pending'` so
  // `npm run admin:submissions review` can still clear them by hand.
  let autoPublishOutcome: AutoPublishResult | null = null;
  if (extracted) {
    try {
      autoPublishOutcome = await tryAutoPublish({
        submissionId,
        barcode,
        extracted,
      });
      log.info('submission_auto_publish_outcome', {
        submission_id: submissionId,
        outcome: autoPublishOutcome.kind,
        ...(autoPublishOutcome.kind === 'published' && {
          product_id: autoPublishOutcome.productId,
          score: autoPublishOutcome.score,
        }),
        ...(autoPublishOutcome.kind === 'skipped' && {
          reason: autoPublishOutcome.reason,
          confidence: extracted.confidence,
        }),
        ...(autoPublishOutcome.kind === 'failed' && {
          error: autoPublishOutcome.error,
        }),
      });
    } catch (err) {
      // Defensive: tryAutoPublish traps its own errors, but if anything
      // escapes we must not fail the request — the submission and photos
      // are already durable in storage and the DB.
      log.warn('submission_auto_publish_threw', {
        submission_id: submissionId,
        error: String(err),
      });
    }
  }

  if (autoPublishOutcome?.kind === 'published') {
    return NextResponse.json(
      {
        submission_id: submissionId,
        status: 'auto_published',
        product_id: autoPublishOutcome.productId,
        message: 'Thanks! This product has been added to the catalog.',
      },
      { status: 201 },
    );
  }

  return NextResponse.json(
    {
      submission_id: submissionId,
      status: 'pending_review',
      message: "Thank you! We'll review your submission within 24 hours.",
    },
    { status: 201 },
  );
}
