import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AiJob } from '@/lib/ai-types';
import { heroCutoutSemanticRetryBrief } from '@/lib/ai-types';
import { getDb } from '@/server/db';
import { approvedImageModel, canRestoreHeroContents, canRetryMissingHeroMask, failedHeroSourcePrefix, heroCutoutModel, isRecoverableHeroSource } from './image-actions';
import { aiJobs } from './schema';
import type { AiTransaction } from './store';
import { isCompleteHeroComposition } from './hero-retake';

type Row = typeof aiJobs.$inferSelect;
type Database = ReturnType<typeof getDb> | AiTransaction;
export type PhotoRecoveryReadOptions = { allowMaskRetry?: boolean };
export type PhotoRecoverySource = Pick<Row, 'id' | 'recipeId' | 'kind' | 'provider' | 'model' | 'status' | 'providerRequestId' | 'providerFinishedAt' | 'result' | 'appliedRevision' | 'errorCode'> & { manualPhotoComposition?: boolean; brief?: string };
export type PhotoRecoveryChild = PhotoRecoverySource & Pick<Row, 'brief' | 'errorMessage' | 'chargedUsd' | 'costBasis' | 'createdAt'> & { sourceImage: string | null; heroMaskPromptVersion: string | null; heroContainer: string | null };
const sourceImage = sql<string | null>`${aiJobs.input}->'recipe'->>'image'`;
const sourceSelection = { id: aiJobs.id, recipeId: aiJobs.recipeId, kind: aiJobs.kind, provider: aiJobs.provider,
  model: aiJobs.model, status: aiJobs.status, providerRequestId: aiJobs.providerRequestId, providerFinishedAt: aiJobs.providerFinishedAt,
  result: aiJobs.result, appliedRevision: aiJobs.appliedRevision, errorCode: aiJobs.errorCode, brief: aiJobs.brief,
  manualPhotoComposition: sql<boolean>`coalesce(${aiJobs.input}->'aiPhotography'->'regenerate' = 'true'::jsonb, false)` };

function sourceId(value: string | null): string | null {
  if (!value?.startsWith(failedHeroSourcePrefix)) return null;
  const id = value.slice(failedHeroSourcePrefix.length);
  return /^[a-f0-9-]{36}$/i.test(id) ? id : null;
}

/** Completed originals remain valid lineage, without reopening paid mask admission. */
function completedHeroSource(source: PhotoRecoverySource): source is PhotoRecoverySource & { status: 'ready' | 'applied' } {
  const asset = source.result?.asset;
  return Boolean(source.kind === 'hero' && source.provider === 'fal' && source.model === approvedImageModel
    && /^[a-f0-9-]{36}$/i.test(source.id) && source.providerRequestId && /^[A-Za-z0-9_-]{1,100}$/.test(source.providerRequestId)
    && source.providerFinishedAt && source.errorCode === null
    && (source.status === 'ready' && source.appliedRevision === null
      || source.status === 'applied' && Number.isSafeInteger(source.appliedRevision) && Number(source.appliedRevision) > 0)
    && source.result?.content === null && asset && /^[a-f0-9-]{36}$/i.test(asset.id)
    && asset.jobId === source.id && asset.recipeId === source.recipeId && asset.kind === 'hero' && asset.targetId === null
    && asset.model === source.model && asset.src === `/media/${asset.id}`);
}

function isLineageSource(source: PhotoRecoverySource) {
  return isRecoverableHeroSource(source, source.recipeId) || completedHeroSource(source);
}

/** Attach lineage without replacing the original status, receipt, result or settled bill. */
export function attachPhotoRecovery(jobs: AiJob[], sources: PhotoRecoverySource[], children: PhotoRecoveryChild[], options: PhotoRecoveryReadOptions = {}): AiJob[] {
  const originals = sources.filter(isLineageSource).map(source => ({ ...source,
    manualPhotoComposition: isCompleteHeroComposition(source.manualPhotoComposition, source.brief) }));
  return jobs.map(job => {
    if (job.kind !== 'hero') return job;
    const directChild = job.provider === 'fal' && job.model === heroCutoutModel
      ? children.find(child => child.id === job.id && child.recipeId === job.recipeId && child.kind === 'hero' && child.provider === 'fal' && child.model === heroCutoutModel)
      : undefined;
    const original = originals.find(source => source.recipeId === job.recipeId && source.id === (directChild ? sourceId(directChild.sourceImage) : job.id));
    if (!original) return job;
    if (completedHeroSource(original)) {
      const resolved = { ...job };
      delete resolved.photoRecovery;
      delete resolved.canRetryPhotoMask;
      delete resolved.canRestorePhotoContents;
      if (original.manualPhotoComposition) resolved.manualPhotoComposition = true;
      if (directChild) { resolved.photoSourceJobId = original.id; resolved.photoSourceStatus = original.status; }
      return resolved;
    }
    const related = children.filter(child => child.recipeId === original.recipeId && child.sourceImage === failedHeroSourcePrefix + original.id
      && child.kind === 'hero' && child.provider === 'fal' && child.model === heroCutoutModel)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = related.find(child => ['ready', 'applied'].includes(child.status) && Boolean(child.result?.asset)) ?? related[0];
    if (!latest) return job;
    const retryAvailable = !original.manualPhotoComposition && options.allowMaskRetry && !related.some(child => child.brief === heroCutoutSemanticRetryBrief)
      && canRetryMissingHeroMask({ ...latest, input: { recipe: { image: latest.sourceImage ?? '' }, aiPhotography: { heroMaskPromptVersion: latest.heroMaskPromptVersion ?? undefined } } }, heroCutoutSemanticRetryBrief, original.id);
    const restoreAvailable = !original.manualPhotoComposition && job.id === latest.id && canRestoreHeroContents({ ...latest, input: {
      recipe: { image: latest.sourceImage ?? '', heroPresentation: { container: latest.heroContainer ?? undefined } },
      aiPhotography: { heroMaskPromptVersion: latest.heroMaskPromptVersion ?? undefined },
    } });
    return { ...job,
      ...(original.manualPhotoComposition ? { manualPhotoComposition: true } : {}),
      ...(job.id === original.id ? { photoRecovery: { jobId: latest.id, status: latest.status, errorCode: latest.errorCode, chargedUsd: latest.chargedUsd, costBasis: latest.costBasis } }
        : { photoSourceJobId: original.id }),
      ...(retryAvailable && (job.id === original.id || job.id === latest.id) ? { canRetryPhotoMask: true } : {}),
      ...(restoreAvailable ? { canRestorePhotoContents: true } : {}),
    };
  });
}

/** GET-only lookup: background corrections are admitted exclusively by mutation/worker paths. */
export async function withPhotoRecovery(jobs: AiJob[], options: PhotoRecoveryReadOptions = {}, db: Database = getDb()): Promise<AiJob[]> {
  const heroes = jobs.filter(job => job.kind === 'hero' && [approvedImageModel, heroCutoutModel].includes(job.model));
  if (!heroes.length) return jobs;
  const childIds = heroes.filter(job => job.model === heroCutoutModel).map(job => job.id);
  const childLinks = childIds.length ? await db.select({ sourceImage }).from(aiJobs).where(inArray(aiJobs.id, childIds)) : [];
  const originalIds = [...new Set([...heroes.filter(job => job.model === approvedImageModel).map(job => job.id), ...childLinks.map(child => sourceId(child.sourceImage)).filter((id): id is string => Boolean(id))])];
  if (!originalIds.length) return jobs;
  const sources = await db.select(sourceSelection).from(aiJobs).where(inArray(aiJobs.id, originalIds));
  const validSources = sources.filter(isLineageSource);
  if (!validSources.length) return jobs;
  const children = await db.select({ ...sourceSelection, brief: aiJobs.brief, errorMessage: aiJobs.errorMessage,
    chargedUsd: aiJobs.chargedUsd, costBasis: aiJobs.costBasis, createdAt: aiJobs.createdAt, sourceImage,
    heroMaskPromptVersion: sql<string | null>`${aiJobs.input}->'aiPhotography'->>'heroMaskPromptVersion'`,
    heroContainer: sql<string | null>`coalesce(${aiJobs.input}->'aiPhotography'->'heroPresentationOverride'->>'container', ${aiJobs.input}->'recipe'->'heroPresentation'->>'container')` }).from(aiJobs)
    .where(and(eq(aiJobs.kind, 'hero'), eq(aiJobs.provider, 'fal'), eq(aiJobs.model, heroCutoutModel),
      inArray(aiJobs.recipeId, [...new Set(validSources.map(source => source.recipeId))]),
      inArray(sourceImage, validSources.map(source => failedHeroSourcePrefix + source.id))))
    .orderBy(desc(aiJobs.createdAt));
  return attachPhotoRecovery(jobs, validSources, children, options);
}
