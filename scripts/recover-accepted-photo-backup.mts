import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { getDb, closeDb } from '../src/server/db';
import { editorialRecipes } from '../src/server/db/schema';
import { aiJobs, aiPhotoBatches } from '../src/server/ai/schema';
import { approvedImageModel } from '../src/server/ai/image-actions';
import { readProviderBackup } from '../src/server/ai/provider-backup';
import { pollImage } from '../src/server/ai/image-provider';
import { assertPhotoBatchReservation, budgetLock, finishAsset, getJobForExecution, trustedActor } from '../src/server/ai/store';
import { samePhotoSubject } from '../src/server/ai/photo-subject';

const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
config({ path: option('--env') ?? '.env.production.local', quiet: true });
if (process.env.DATABASE_URL) {
  const databaseUrl = new URL(process.env.DATABASE_URL); databaseUrl.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = databaseUrl.href;
}
const jobId = option('--job'), requestId = option('--request'), digest = option('--sha256');
const revision = Number(option('--revision')), generation = Number(option('--generation'));
const apply = process.argv.includes('--apply');
if (!jobId || !requestId || !digest || !/^[a-f0-9-]{36}$/i.test(jobId) || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)
  || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(generation) || generation < 1) throw new Error('EXACT_JOB_RECEIPT_SHA_REVISION_GENERATION_REQUIRED');
if (['FAL_KEY', 'FAL_API_KEY', 'FAL_BILLING_KEY'].some(key => Boolean(process.env[key]))) throw new Error('LOCAL_PROVIDER_KEYS_MUST_BE_ABSENT');
const originalFetch = globalThis.fetch;
globalThis.fetch = (resource, options) => {
  const url = new URL(resource instanceof Request ? resource.url : String(resource));
  if (/(?:^|\.)fal\.(?:ai|run|media)$/.test(url.hostname)) throw new Error('PROVIDER_NETWORK_FORBIDDEN_DURING_BACKUP_RECOVERY');
  return originalFetch(resource, options);
};
async function scope() {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, jobId!)).for('share');
    if (!job || job.provider !== 'fal' || job.model !== approvedImageModel || job.kind === 'recipe' || job.providerRequestId !== requestId
      || !job.providerFinishedAt || !job.photoBatchId || !['generating', 'uncertain', 'ready', 'applied'].includes(job.status)) throw new Error('ACCEPTED_COMPLETED_SOURCE_SCOPE_REQUIRED');
    const [batch] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, job.photoBatchId)).for('update');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, job.recipeId)).for('share');
    if (!batch || batch.createdBy !== job.createdBy || batch.recipeId !== job.recipeId || batch.generation !== generation
      || !batch.slots.some(slot => slot.jobId === job.id && slot.kind === job.kind && slot.targetId === job.targetId)) throw new Error('CURRENT_PACKET_GENERATION_AND_SOURCE_REQUIRED');
    await trustedActor(tx, batch.createdBy);
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived' || recipe.revision !== revision || !samePhotoSubject(job.input, recipe.content, job.kind, job.targetId)) throw new Error('CURRENT_RECIPE_SUBJECT_AND_REVISION_REQUIRED');
    await assertPhotoBatchReservation(tx, batch);
    return { job, batch };
  });
}
try {
  const preflight = await scope();
  const backup = await readProviderBackup(jobId, requestId);
  if (!backup || createHash('sha256').update(backup).digest('hex') !== digest) throw new Error('EXACT_PRIVATE_BACKUP_REQUIRED');
  const metadata = await sharp(backup, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height || metadata.depth !== 'uchar' || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1) throw new Error('BACKUP_IMAGE_INVALID');
  console.log(JSON.stringify({ checked: true, apply, jobId, requestId, backupSha256: digest, bytes: backup.length, width: metadata.width, height: metadata.height,
    status: preflight.job.status, generation, recipeRevision: revision, packetId: preflight.batch.id, originalCeilingUsd: preflight.batch.reservedUsd,
    paidSubmission: false, providerNetworkForbidden: true }));
  if (apply && !preflight.job.result) {
    const job = await getJobForExecution(jobId);
    if (job.kind === 'recipe') throw new Error('PHOTO_ONLY');
    const result = await pollImage(job.model, requestId, job.id, job.kind, job.input, job.targetId);
    if (!result.done) throw new Error('VERIFIED_BACKUP_DID_NOT_COMPLETE');
    const current = await scope();
    // Keep an already verified bill if one was recorded while bytes were saved.
    const cost = current.job.costBasis === 'usage' && current.job.chargedUsd !== null
      ? { chargedUsd: current.job.chargedUsd, costBasis: 'usage' as const } : result.cost;
    const finished = await finishAsset(job.id, result.asset, cost, [...result.notes, 'Odzyskano dokładny wynik istniejącego zgłoszenia z prywatnej kopii o sprawdzonym SHA-256. Bez nowego zgłoszenia do dostawcy.']);
    console.log(JSON.stringify({ recovered: true, jobId: finished.id, status: finished.status, src: finished.result?.asset?.src,
      providerRequestId: finished.providerRequestId, chargedUsd: finished.chargedUsd, costBasis: finished.costBasis, paidSubmission: false }));
  }
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  console.error('BACKUP_RECOVERY_FAILED', /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'UNCLASSIFIED_PRIVATE_DIAGNOSTIC'); process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; await closeDb(); }
