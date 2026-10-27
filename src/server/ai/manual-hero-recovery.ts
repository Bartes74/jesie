import 'server-only';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { aiJobs } from './schema';
import { budgetLock, trustedActor } from './store';
import { failedHeroSourcePrefix, heroCutoutModel, isRecoverablePhotoSource } from './image-actions';
import { samePhotoSubject } from './photo-subject';

export type ManualHeroCutoutOperation = { jobId: string; created: boolean; run: boolean } | null;

function operation(child: typeof aiJobs.$inferSelect, sourceId: string, workflowRunId: string, created: boolean): ManualHeroCutoutOperation {
  return { jobId: child.id, created,
    run: child.input.aiPhotography?.automaticHeroCutout?.sourceJobId === sourceId
      && child.input.aiPhotography.automaticHeroCutout.workflowRunId === workflowRunId
      && Boolean(child.providerRequestId)
      && !child.result && ['queued', 'submitting', 'generating'].includes(child.status) };
}

/** Free-form retakes have no complete segmentation contract. Resume accepted receipts only. */
export async function admitManualHeroCutout(sourceId: string, workflowRunId: string): Promise<ManualHeroCutoutOperation> {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const [source] = await tx.select().from(aiJobs).where(eq(aiJobs.id, sourceId)).for('update');
    if (!source || source.trendRunId || source.photoBatchId || source.input.aiPhotography?.regenerate !== true
      || !isRecoverablePhotoSource(source, source.recipeId, 'hero')) return null;
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, source.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived'
      || !samePhotoSubject(source.input, recipe.content, 'hero', null)
      || contentApprovalHash(source.input) !== contentApprovalHash(recipe.content)) return null;
    const actor = await trustedActor(tx, source.createdBy);
    const requestKey = `manual_hero_cutout_${source.id}`;
    const [existing] = await tx.select().from(aiJobs).where(and(eq(aiJobs.createdBy, actor.id), eq(aiJobs.requestKey, requestKey))).for('update');
    // A retake may replace the vessel and add detached utensils or props. Its
    // older vessel is therefore not a safe SAM target for the complete scene.
    // Keep the original intact; never buy a mask guessed from that vessel.
    // An already accepted child still owns its receipt and may finish with GETs.
    if (existing) {
      if (existing.recipeId !== recipe.id || existing.kind !== 'hero' || existing.model !== heroCutoutModel
        || existing.input.recipe.image !== `${failedHeroSourcePrefix}${source.id}`
        || !samePhotoSubject(existing.input, source.input, 'hero', null)) return null;
      return operation(existing, source.id, workflowRunId, false);
    }
    return null;
  });
}
