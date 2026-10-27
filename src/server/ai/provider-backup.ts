import 'server-only';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const directory = () => join(process.cwd(), 'private-media/provider-recovery');
const entry = z.object({ jobId: z.string().uuid(), requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(32 * 1024 * 1024) }).strict();
const manifest = z.array(entry).max(100);

/** Private, verified copies of already completed receipts survive provider URL expiry. */
export async function readProviderBackup(jobId: string, requestId: string, storage = {
  manifest: () => readFile(join(directory(), 'manifest.json'), 'utf8'),
  image: (id: string) => readFile(join(directory(), `${id}.webp`)),
}): Promise<Buffer | null> {
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return null;
  let source: string;
  try { source = await storage.manifest(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const retained = manifest.parse(JSON.parse(source)).find(item => item.jobId === jobId && item.requestId === requestId);
  if (!retained) return null;
  const bytes = await storage.image(retained.jobId);
  if (bytes.length !== retained.bytes || createHash('sha256').update(bytes).digest('hex') !== retained.sha256) throw new Error('PROVIDER_BACKUP_INTEGRITY_FAILED');
  return bytes;
}
