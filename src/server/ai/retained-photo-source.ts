import 'server-only';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { CutoutKind, FailedHeroSource } from './image-actions';
import { failedHeroSourcePrefix, heroCutoutModel } from './image-actions';
import { aiAssets, aiJobs } from './schema';
import { getDb } from '../db';
import { samePhotoSubject } from './photo-subject';

type RetainedPhoto = { job: typeof aiJobs.$inferSelect; asset: typeof aiAssets.$inferSelect };

/** The archive must belong to this exact provider result, never just a similar dish. */
export function retainedPhotoSourceMatches(candidate: RetainedPhoto, source: FailedHeroSource, kind: CutoutKind, targetId: string | null) {
  const { job, asset } = candidate;
  const reference = kind === 'hero' ? job.input.recipe.image : targetId ? job.input.photos.ingredients[targetId]?.src : undefined;
  return Boolean(source.input && source.input.recipe.id === source.recipeId
    && job.recipeId === source.recipeId && asset.recipeId === source.recipeId
    && job.kind === kind && asset.kind === kind && job.targetId === targetId && asset.targetId === targetId
    && job.model === heroCutoutModel && asset.model === heroCutoutModel && job.provider === 'fal'
    && ['ready', 'applied'].includes(job.status) && job.providerFinishedAt
    && job.providerRequestId && /^[A-Za-z0-9_-]{1,100}$/.test(job.providerRequestId)
    && job.result?.asset?.id === asset.id && asset.jobId === job.id
    && asset.originalBlobPathname && !asset.originalBlobPathname.includes('://')
    && reference === `${failedHeroSourcePrefix}${source.id}`
    && samePhotoSubject(source.input, job.input, kind, targetId));
}

/** Read only. A completed cutout already retains the opaque source needed by SAM. */
export async function findRetainedPhotoSource(source: FailedHeroSource, kind: CutoutKind, targetId: string | null): Promise<string | null> {
  if (!source.input || !process.env.DATABASE_URL || kind === 'ingredient' && !targetId) return null;
  const reference = kind === 'hero'
    ? sql`${aiJobs.input} -> 'recipe' ->> 'image'`
    : sql`${aiJobs.input} -> 'photos' -> 'ingredients' -> ${targetId} ->> 'src'`;
  const candidates = await getDb().select({ job: aiJobs, asset: aiAssets }).from(aiJobs)
    .innerJoin(aiAssets, eq(aiAssets.jobId, aiJobs.id))
    .where(and(eq(aiJobs.recipeId, source.recipeId), eq(aiJobs.kind, kind),
      targetId ? eq(aiJobs.targetId, targetId) : isNull(aiJobs.targetId),
      eq(aiJobs.model, heroCutoutModel), eq(aiJobs.provider, 'fal'),
      inArray(aiJobs.status, ['ready', 'applied']), isNotNull(aiJobs.providerFinishedAt),
      isNotNull(aiAssets.originalBlobPathname), eq(reference, `${failedHeroSourcePrefix}${source.id}`)))
    .orderBy(desc(aiJobs.createdAt));
  return candidates.find(candidate => retainedPhotoSourceMatches(candidate, source, kind, targetId))?.asset.originalBlobPathname ?? null;
}
