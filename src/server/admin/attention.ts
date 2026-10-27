import 'server-only';
import { eq, inArray, isNull, ne, and, desc, sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { editorialRecipes, editorialAudit, editorialPublications } from '@/server/db/schema';
import { user } from '@/server/db/auth-schema';
import { aiJobs, aiPhotoBatches } from '@/server/ai/schema';
import { editorialContentApprovals } from '@/server/editorial/content-approval-schema';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { recipeAttention, sortAdminAttention } from '@/lib/admin-attention';
import { reviewKeys } from '@/lib/editorial-types';

/** Reads real draft/job states; does not recover tasks, generate content or publish. */
export async function getAdminAttention() {
  const db = getDb();
  const rows = await db.select({ recipe: editorialRecipes,
    hasUnpublishedChanges: sql<boolean>`${editorialPublications.snapshot} IS NULL OR ${editorialPublications.snapshot} IS DISTINCT FROM ${editorialRecipes.content}`,
  }).from(editorialRecipes).leftJoin(editorialPublications, eq(editorialRecipes.publishedId, editorialPublications.id))
    .where(and(isNull(editorialRecipes.deletedAt), ne(editorialRecipes.editorialStatus, 'archived')));
  const recipes = rows.map(({ recipe, hasUnpublishedChanges }) => ({ ...recipe, hasUnpublishedChanges }));
  if (!recipes.length) return [];
  const ids = recipes.map(recipe => recipe.id);
  const [jobs, approvals, batches, manualReviews] = await Promise.all([
    db.select({ id: aiJobs.id, recipeId: aiJobs.recipeId, kind: aiJobs.kind, targetId: aiJobs.targetId, status: aiJobs.status,
      baseRevision: aiJobs.baseRevision, providerRequestId: aiJobs.providerRequestId, providerFinishedAt: aiJobs.providerFinishedAt, updatedAt: aiJobs.updatedAt }).from(aiJobs).where(inArray(aiJobs.recipeId, ids)),
    db.select({ recipeId: editorialContentApprovals.recipeId, contentHash: editorialContentApprovals.contentHash }).from(editorialContentApprovals).where(inArray(editorialContentApprovals.recipeId, ids)),
    db.select({ recipeId: aiPhotoBatches.recipeId, status: aiPhotoBatches.status, updatedAt: aiPhotoBatches.updatedAt }).from(aiPhotoBatches).where(inArray(aiPhotoBatches.recipeId, ids)).orderBy(desc(aiPhotoBatches.createdAt)),
    db.select({ recipeId: editorialAudit.recipeId, revision: editorialAudit.revision }).from(editorialAudit).innerJoin(user, eq(user.id, editorialAudit.actorId))
      .where(and(inArray(editorialAudit.recipeId, ids), eq(editorialAudit.action, 'approve'), eq(user.disabled, false), inArray(user.role, ['owner', 'admin']))),
  ]);
  const approved = new Set(approvals.map(item => `${item.recipeId}:${item.contentHash}`));
  const reviewed = new Set(manualReviews.map(item => `${item.recipeId}:${item.revision}`));
  const grouped = new Map<string, typeof jobs>();
  for (const job of jobs) { const list = grouped.get(job.recipeId) ?? []; list.push(job); grouped.set(job.recipeId, list); }
  return sortAdminAttention(recipes.flatMap(recipe => {
    const legacyApproved = recipe.editorialStatus === 'approved' && recipe.approvedRevision === recipe.revision && recipe.checksRevision === recipe.revision
      && reviewKeys.every(key => recipe.checks[key]) && reviewed.has(`${recipe.id}:${recipe.revision}`);
    const item = recipeAttention(recipe, grouped.get(recipe.id) ?? [], legacyApproved || approved.has(`${recipe.id}:${contentApprovalHash(recipe.content)}`), batches.find(batch => batch.recipeId === recipe.id));
    return item ? [item] : [];
  }));
}
