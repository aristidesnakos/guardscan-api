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
    });
  if (error) throw error;
  return path; // store path not URL — sign on demand
}

export async function signedSubmissionUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { data, error } = await getStorageClient()
    .storage
    .from('submissions')
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw error ?? new Error('signed_url_failed');
  return data.signedUrl;
}
