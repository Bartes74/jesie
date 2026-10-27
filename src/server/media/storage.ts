import 'server-only';
import { get } from '@vercel/blob';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { readLocalRecoveredMedia } from '@/server/media/local-recovery';

/** Resolves verified, lossless encodings without changing immutable media history. */
export async function getMediaBlob(pathname: string, options: { useCache?: boolean } = {}) {
  // Verified copies stay inside the server bundle. Publication/admin checks in
  // callers still decide who may receive them, including after a withdrawal.
  const recovered = await readLocalRecoveredMedia(pathname);
  if (recovered) return {
    statusCode: 200 as const,
    stream: new Response(new Uint8Array(recovered.bytes)).body!,
    blob: { size: recovered.bytes.length, contentType: recovered.contentType },
  };
  let target = pathname;
  if (process.env.DATABASE_URL && pathname.startsWith('ai/') && !pathname.startsWith('ai/compact/')) {
    const result = await getDb().execute(sql`SELECT target_pathname FROM media_compaction WHERE source_pathname=${pathname}`);
    if (result.rows.length) target = String(result.rows[0].target_pathname);
  }
  return get(target, { access: 'private', ...options });
}
