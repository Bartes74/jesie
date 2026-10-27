import 'server-only';
import { sql } from 'drizzle-orm';
import type { AiJob } from '@/lib/ai-types';
import { heroPresentationProfile, type HeroContainer } from '@/lib/hero-presentation';
import { capturedIngredientStyleProfile } from './ingredient-profile';
import { aiJobs } from './schema';
import { isCompleteHeroComposition } from './hero-retake';

type JobRow = typeof aiJobs.$inferSelect;
type PresentationKeys = 'id' | 'recipeId' | 'baseRevision' | 'kind' | 'targetId' | 'status'
  | 'provider' | 'model' | 'brief' | 'createdByName' | 'createdAt' | 'updatedAt'
  | 'providerRequestId' | 'reservedUsd' | 'chargedUsd' | 'costBasis' | 'usage'
  | 'errorCode' | 'errorMessage' | 'result' | 'appliedRevision' | 'reuseSourceJobId';
export type JobPresentationRow = Pick<JobRow, PresentationKeys> & {
  recipeTitle: string;
  ingredientStyleProfile: string | null;
  heroStyleProfile: string | null;
  heroContainer: HeroContainer | null;
  manualPhotoComposition?: boolean;
};

/** Studio polls must not transfer each job's complete captured editorial input. */
export const jobPresentationSelection = {
  id: aiJobs.id, recipeId: aiJobs.recipeId, baseRevision: aiJobs.baseRevision,
  kind: aiJobs.kind, targetId: aiJobs.targetId, status: aiJobs.status,
  provider: aiJobs.provider, model: aiJobs.model, brief: aiJobs.brief,
  createdByName: aiJobs.createdByName, createdAt: aiJobs.createdAt, updatedAt: aiJobs.updatedAt,
  providerRequestId: aiJobs.providerRequestId, reservedUsd: aiJobs.reservedUsd,
  chargedUsd: aiJobs.chargedUsd, costBasis: aiJobs.costBasis, usage: aiJobs.usage,
  errorCode: aiJobs.errorCode, errorMessage: aiJobs.errorMessage, result: aiJobs.result,
  appliedRevision: aiJobs.appliedRevision, reuseSourceJobId: aiJobs.reuseSourceJobId,
  recipeTitle: sql<string>`${aiJobs.input}->'recipe'->'title'->>'pl'`,
  ingredientStyleProfile: sql<string | null>`${aiJobs.input}->'aiPhotography'->>'ingredientStyleProfile'`,
  heroStyleProfile: sql<string | null>`${aiJobs.input}->'aiPhotography'->>'heroStyleProfile'`,
  manualPhotoComposition: sql<boolean>`coalesce(${aiJobs.input}->'aiPhotography'->>'regenerate','false')='true'`,
  heroContainer: sql<HeroContainer | null>`coalesce(${aiJobs.input}->'aiPhotography'->'heroPresentationOverride'->>'container', ${aiJobs.input}->'recipe'->'heroPresentation'->>'container')`,
};

/** Both full worker rows and compact polling rows retain one display contract. */
export function jobPresentationDto(row: JobPresentationRow): AiJob {
  const profile = row.kind === 'ingredient' ? capturedIngredientStyleProfile({
    aiPhotography: { ingredientStyleProfile: row.ingredientStyleProfile ?? undefined },
  }) : undefined;
  const result = row.result && profile ? {
    ...row.result,
    ...(row.result.asset ? { asset: { ...row.result.asset, styleProfile: profile } } : {}),
    ...(row.result.reusedPhoto ? { reusedPhoto: { ...row.result.reusedPhoto, styleProfile: profile } } : {}),
  } : row.result;
  return {
    id: row.id, recipeId: row.recipeId, recipeTitle: row.recipeTitle,
    baseRevision: row.baseRevision, kind: row.kind, targetId: row.targetId,
    status: row.status, provider: row.provider, model: row.model, brief: row.brief,
    createdByName: row.createdByName, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    providerRequestId: row.providerRequestId, reservedUsd: row.reservedUsd, chargedUsd: row.chargedUsd,
    costBasis: row.costBasis, usage: row.usage, errorCode: row.errorCode, errorMessage: row.errorMessage,
    result, appliedRevision: row.appliedRevision, reuseSourceJobId: row.reuseSourceJobId,
    ...(row.kind === 'hero' && isCompleteHeroComposition(row.manualPhotoComposition, row.brief) ? { manualPhotoComposition: true } : {}),
    ...(row.kind === 'hero' && row.heroStyleProfile === heroPresentationProfile
      ? { heroContainer: row.heroContainer ?? undefined } : {}),
  };
}
