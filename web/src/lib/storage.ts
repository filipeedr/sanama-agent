import { getServerEnv } from './env';
import { getServiceSupabase } from './supabase';

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export async function uploadDocumentBinary(
  namespace: string,
  originalName: string,
  buffer: Buffer,
  contentType: string | null
): Promise<string> {
  const env = getServerEnv();
  const supabase = getServiceSupabase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = slugify(originalName || 'document');
  const path = `${namespace}/${timestamp}-${safeName}`;

  const { error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: contentType ?? 'application/octet-stream',
      upsert: false
    });

  if (error) {
    throw new Error(`Falha ao enviar para o storage: ${error.message}`);
  }

  return path;
}

export async function downloadDocumentBinary(path: string): Promise<Buffer> {
  const env = getServerEnv();
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).download(path);

  if (error || !data) {
    throw new Error(`Não foi possível baixar o arquivo (${path}): ${error?.message}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function getPublicDocumentUrl(path: string) {
  const env = getServerEnv();
  const supabase = getServiceSupabase();
  const { data } = supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function deleteDocumentBinaries(paths: string[]) {
  if (!paths.length) return;
  const env = getServerEnv();
  const supabase = getServiceSupabase();
  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove(paths);
  if (error) {
    console.warn('[storage] Falha ao remover arquivos do storage', error);
  }
}
