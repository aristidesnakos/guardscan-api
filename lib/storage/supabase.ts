import { createClient } from '@supabase/supabase-js';

let client: ReturnType<typeof createClient> | null = null;

function getStorageClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'Supabase Storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  if (!client) {
    client = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export async function uploadSubmissionPhoto(
  submissionId: string,
  role: 'front' | 'back',
  file: Blob,
): Promise<string> {
  const path = `${submissionId}/${role}.jpg`;
  const { error } = await getStorageClient()
    .storage
    .from('submissions')
    .upload(path, file, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '31536000', // 1 year — immutable product photos
    });
  if (error) throw error;
  return path; // store relative path; URL constructed in resolveImageUrl
}

/**
 * Resolve a product's image_front value to a usable URL.
 * - HTTP(S) URLs (from OFF/OBF) pass through unchanged.
 * - Supabase Storage paths (from user submissions) become public CDN URLs.
 * - Null/empty returns null.
 */
export function resolveImageUrl(imageFront: string | null): string | null {
  if (!imageFront) return null;
  if (imageFront.startsWith('http')) return imageFront;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;
  return `${supabaseUrl}/storage/v1/object/public/submissions/${imageFront}`;
}
