import { readFile, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Client } from 'pg';
import { del, head, list } from '@vercel/blob';
import { isRecoverablePhotoSource } from '../src/server/ai/image-actions';
import { retainedPhotoSourceMatches } from '../src/server/ai/retained-photo-source';
import type { aiJobs, aiAssets } from '../src/server/ai/schema';

const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const apply = process.argv.includes('--apply');
const manifestPath = option('--manifest');
const reportPath = option('--report');
type Job = typeof aiJobs.$inferSelect;
type Asset = typeof aiAssets.$inferSelect;
type Candidate = { pathname: string; bytes: number; etag: string; sourceJobId: string; kind: 'hero' | 'ingredient';
  retainedArchive: { pathname: string; assetId: string; jobId: string; bytes: number; etag: string } };
function camel<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])) as T;
}
function literalPath(value: unknown, paths: Set<string>): string | undefined {
  if (typeof value === 'string') return paths.has(value.replace(/^\//, '')) ? value.replace(/^\//, '') : undefined;
  if (Array.isArray(value)) return value.map(item => literalPath(item, paths)).find(Boolean);
  if (value && typeof value === 'object') return Object.values(value).map(item => literalPath(item, paths)).find(Boolean);
}
async function main() {
  if (!manifestPath || !reportPath) throw new Error('AUDITED_MANIFEST_AND_REPORT_REQUIRED');
  config({ path: option('--env') || '.env.local', quiet: true });
  if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('DATABASE_AND_STORAGE_REQUIRED');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const candidates: Candidate[] = manifest.rows;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 33
    || Date.now() - new Date(manifest.exportedAt).getTime() > 60 * 60 * 1000
    || manifest.noDatabaseMutations !== true || manifest.noBlobMutations !== true) throw new Error('FRESH_AUDITED_MANIFEST_REQUIRED');
  const paths = new Set(candidates.map(row => row.pathname));
  if (paths.size !== candidates.length || candidates.some(row => !/^ai\/[a-f0-9-]{36}\/recovered-original\.png$/.test(row.pathname)
    || !/^ai\/[a-f0-9-]{36}\/original(?:-v1)?\.(png|webp)$/.test(row.retainedArchive.pathname)
    || row.pathname !== `ai/${row.sourceJobId}/recovered-original.png`
    || !/^"[a-f0-9]{32}"$/.test(row.etag) || row.etag !== row.retainedArchive.etag
    || row.bytes !== row.retainedArchive.bytes || !Number.isInteger(row.bytes) || row.bytes < 1)) throw new Error('CACHE_MANIFEST_SCOPE_INVALID');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set('sslmode', 'verify-full');
  const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
  const removed: Candidate[] = [];
  let locked = false;
  await db.connect();
  try {
    await db.query("SELECT pg_advisory_lock(hashtext('jesie-media-compaction'))"); locked = true;
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const jobs = (await db.query('SELECT * FROM ai_job')).rows.map(row => camel<Job>(row));
    const assets = (await db.query('SELECT * FROM ai_asset')).rows.map(row => camel<Asset>(row));
    const data = [jobs.map(row => [row.input, row.result]), (await db.query('SELECT content FROM editorial_recipe')).rows,
      (await db.query('SELECT content FROM editorial_version')).rows, (await db.query('SELECT snapshot FROM editorial_publication')).rows,
      (await db.query('SELECT input,slots FROM ai_photo_batch')).rows, (await db.query('SELECT photo FROM ingredient_image_catalog')).rows,
      (await db.query('SELECT data FROM trend_candidate')).rows];
    if (literalPath(data, paths)) throw new Error('AUXILIARY_CACHE_HAS_LITERAL_REFERENCE');
    for (const row of candidates) {
      const source = jobs.find(job => job.id === row.sourceJobId);
      const job = jobs.find(job => job.id === row.retainedArchive.jobId);
      const asset = assets.find(item => item.id === row.retainedArchive.assetId);
      const ingredient = row.kind === 'ingredient' ? source?.input.recipe.ingredients.find(item => item.id === source.targetId) : undefined;
      if (!source || !job || !asset || !isRecoverablePhotoSource(source, source.recipeId, row.kind, source.targetId, ingredient)
        || !retainedPhotoSourceMatches({ job, asset }, source, row.kind, source.targetId)
        || asset.originalBlobPathname !== row.retainedArchive.pathname
        || assets.some(item => item.blobPathname === row.pathname || item.originalBlobPathname === row.pathname)) throw new Error('RETAINED_ARCHIVE_BINDING_CHANGED');
      if (jobs.some(item => item.model === 'fal-ai/sam-3/image' && ['queued', 'submitting', 'generating', 'uncertain'].includes(item.status)
        && (item.kind === 'hero' ? item.input.recipe.image : item.targetId ? item.input.photos.ingredients[item.targetId]?.src : undefined) === `/ai-result/${source.id}`)) throw new Error('CACHE_CONSUMER_STILL_ACTIVE');
    }
    await db.query('COMMIT');
    const report = { checkedAt: new Date().toISOString(), mode: apply ? 'conditional-recovery-cache-eviction' : 'recovery-cache-plan',
      candidates: candidates.length, plannedBytes: candidates.reduce((sum, row) => sum + row.bytes, 0), removed,
      registeredPhotographsDeleted: 0, immutableDatabaseRecordsChanged: 0, providerSubmissions: 0,
      restoration: 'Each auxiliary cache can be recreated from its retainedArchive pathname. Those immutable originals remain stored and the deployed reader uses them first.' };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    for (const row of candidates) {
      const [cache, archive] = await Promise.all([head(row.pathname, { token }), head(row.retainedArchive.pathname, { token })]);
      if (cache.pathname !== row.pathname || archive.pathname !== row.retainedArchive.pathname
        || cache.size !== row.bytes || archive.size !== row.bytes || cache.etag !== row.etag || archive.etag !== row.etag
        || cache.contentType !== 'image/png' || archive.contentType !== 'image/png') throw new Error('FINAL_ARCHIVE_METADATA_MISMATCH');
      if (apply) {
        await del(row.pathname, { token, ifMatch: cache.etag });
        removed.push(row);
        await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      }
    }
    const inventory: Awaited<ReturnType<typeof list>>['blobs'] = []; let cursor: string | undefined;
    do { const page = await list({ token, limit: 1000, ...(cursor ? { cursor } : {}) }); inventory.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined; } while (cursor);
    if (apply && removed.some(row => inventory.some(item => item.pathname === row.pathname))) throw new Error('DELETION_NOT_CONFIRMED');
    if (candidates.some(row => !inventory.some(item => item.pathname === row.retainedArchive.pathname && item.size === row.bytes && item.etag === row.etag))) throw new Error('RETAINED_ARCHIVE_VERIFICATION_FAILED');
    const result = { ...report, finishedAt: new Date().toISOString(), removedFiles: removed.length,
      freedBytes: removed.reduce((sum, row) => sum + row.bytes, 0), usedBytes: inventory.reduce((sum, row) => sum + row.size, 0),
      retainedArchivesVerified: candidates.length, allRegisteredPhotographsPreserved: true };
    await writeFile(reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ mode: result.mode, candidates: result.candidates, removedFiles: result.removedFiles, freedBytes: result.freedBytes,
      usedBytes: result.usedBytes, retainedArchivesVerified: result.retainedArchivesVerified, registeredPhotographsDeleted: 0 }));
  } finally {
    await db.query('ROLLBACK');
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext('jesie-media-compaction'))");
    await db.end();
  }
}
main().catch(error => { console.error('Recovery cache maintenance stopped:', error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_UNAVAILABLE'); process.exitCode = 1; });
