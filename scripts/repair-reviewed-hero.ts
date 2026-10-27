import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../src/server/db';
import { aiPhotoBatches, aiAssets, aiJobs } from '../src/server/ai/schema';
import { getMediaBlob } from '../src/server/media/storage';
import { fillReviewedHeroSeams, maskReviewedRoundVessel, type PhotoBounds } from '../src/server/ai/photo-format';
import { importReviewedHeroCorrection, type ReviewedHeroCorrection } from '../src/server/ai/reviewed-photo-correction';

// Prepare is read-only against production. Apply requires the separate reviewed
// manifest; the importer checks all pixels, current generation, completed slots,
// actor, immutable source bindings and packet costs again under the budget lock.
type Preparation = Omit<ReviewedHeroCorrection, 'sha256' | 'sourceSha256'> & { bridges?: PhotoBounds[]; ellipse?: PhotoBounds };
const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
config({ path: option('--env') ?? '.env.production.local', quiet: true });
async function bytes(pathname: string) {
  const blob = await getMediaBlob(pathname, { useCache: false });
  if (!blob || blob.statusCode !== 200) throw new Error('SOURCE_READ_UNAVAILABLE');
  const reader = blob.stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length;
    if (length > 32 * 1024 * 1024) throw new Error('SOURCE_TOO_LARGE'); chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
async function main() { try {
  const manifestPath = option('--manifest'); if (!manifestPath) throw new Error('MANIFEST_REQUIRED');
  const input = JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as Preparation | ReviewedHeroCorrection;
  if (process.argv.includes('--prepare') === process.argv.includes('--apply')) throw new Error('CHOOSE_PREPARE_OR_APPLY');
  if (process.argv.includes('--prepare')) {
    const preparation = input as Preparation;
    if (!isAbsolute(preparation.localPath)) throw new Error('ABSOLUTE_OUTPUT_REQUIRED');
    const [asset] = await getDb().select().from(aiAssets).where(eq(aiAssets.id, preparation.sourceAssetId));
    if (!asset || asset.jobId !== preparation.sourceJobId || !asset.originalBlobPathname) throw new Error('SOURCE_ASSET_BINDING_INVALID');
    const [source, cutout] = await Promise.all([bytes(asset.originalBlobPathname), bytes(asset.blobPathname)]);
    if (Boolean(preparation.ellipse) === Boolean(preparation.bridges)) throw new Error('CHOOSE_REVIEWED_SEAMS_OR_ROUND_OUTLINE');
    const corrected = preparation.ellipse ? await maskReviewedRoundVessel(source, preparation.ellipse) : await fillReviewedHeroSeams(source, cutout, preparation.bridges!);
    await mkdir(dirname(preparation.localPath), { recursive: true, mode: 0o700 });
    try { await writeFile(preparation.localPath, corrected.bytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || sha(await readFile(preparation.localPath)) !== sha(corrected.bytes)) throw error; }
    const data = { ...preparation }; delete (data as Partial<Preparation>).bridges; delete (data as Partial<Preparation>).ellipse;
    const reviewed: ReviewedHeroCorrection = { ...data, sha256: sha(corrected.bytes), sourceSha256: sha(source) };
    const reviewedPath = option('--reviewed-manifest') ?? `${resolve(manifestPath)}.reviewed.json`;
    await writeFile(reviewedPath, JSON.stringify(reviewed, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, productionMutation: false, paidSubmission: false, reviewedManifest: reviewedPath,
      file: preparation.localPath, width: corrected.width, height: corrected.height,
      ...( 'filledPixels' in corrected && 'bridgedPixels' in corrected ? { filledPixels: corrected.filledPixels, bridgedPixels: corrected.bridgedPixels } : { method: 'reviewed_round_outline' }) }));
  } else {
    const [batch] = await getDb().select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, input.batchId));
    if (!batch) throw new Error('BATCH_NOT_FOUND');
    const result = await importReviewedHeroCorrection(input as ReviewedHeroCorrection,
      { id: batch.createdBy, name: batch.createdByName, role: 'admin', email: '' });
    const [correction] = await getDb().select({ id: aiJobs.id, appliedRevision: aiJobs.appliedRevision }).from(aiJobs).where(eq(aiJobs.requestKey, input.requestKey));
    console.log(JSON.stringify({ imported: true, paidSubmission: false, batchId: result.id, status: result.status, originalCeilingUsd: result.reservedUsd,
      remainingReservedUsd: result.remainingReservedUsd, heroJobId: correction?.id, appliedDraftRevision: correction?.appliedRevision ?? null }));
  }
} finally { await closeDb(); } }
void main().catch(error => { console.error('REVIEWED_HERO_CORRECTION_FAILED', error instanceof Error && 'code' in error ? String(error.code) : 'CHECK_PRIVATE_MANIFEST'); process.exitCode = 1; });
