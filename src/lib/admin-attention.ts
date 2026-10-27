import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import type { EditorialContent, EditorialStatus, PublicationStatus } from './editorial-types';
import type { AiStatus } from './ai-types';
import type { AiPhotoBatchStatus } from './ai-photo-batch-types';

export type AdminAttentionItem = {
  id: string; title: string; kind: 'generation_problem' | 'generating' | 'content_review' | 'photos' | 'ready' | 'draft';
  priority: number; description: string; href: string; actionLabel: string; updatedAt: string;
};
export type AttentionRecipe = {
  id: string; revision: number; content: EditorialContent; editorialStatus: EditorialStatus;
  publicationStatus: PublicationStatus; publishedRevision: number | null; hasUnpublishedChanges: boolean; deletedAt: Date | null; updatedAt: Date;
};
export type AttentionJob = {
  id: string; recipeId: string; kind: string; targetId: string | null; status: AiStatus;
  baseRevision: number; providerRequestId: string | null; providerFinishedAt: Date | null; updatedAt: Date;
};
export type AttentionBatch = { status: AiPhotoBatchStatus; updatedAt: Date };

/** One actionable row per recipe. A superseded failed photograph never outranks its successful replacement. */
export function recipeAttention(recipe: AttentionRecipe, jobs: AttentionJob[], contentApproved: boolean, batch?: AttentionBatch): AdminAttentionItem | null {
  if (recipe.deletedAt || recipe.editorialStatus === 'archived') return null;
  const currentJobs = new Map<string, AttentionJob>();
  for (const job of [...jobs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    const key = `${job.kind}:${job.targetId ?? ''}`;
    if (!currentJobs.has(key)) currentJobs.set(key, job);
  }
  const base = { id: recipe.id, title: recipe.content.recipe.title.pl || recipe.content.recipe.title.en || 'Bez tytułu',
    href: `/admin/recipes/${encodeURIComponent(recipe.id)}`, updatedAt: recipe.updatedAt.toISOString() };
  const unresolved = jobs.find(job => job.status === 'uncertain' || (job.providerRequestId !== null || job.status === 'cancelled') && !job.providerFinishedAt && !['submitting', 'generating'].includes(job.status));
  if (unresolved) return { ...base, kind: 'generation_problem', priority: 0, description: 'Sprawdź zachowane zgłoszenie przed kolejnym generowaniem.', href: `/admin/ai/${encodeURIComponent(unresolved.id)}`, actionLabel: 'Sprawdź zgłoszenie', updatedAt: unresolved.updatedAt.toISOString() };
  const content = recipe.content; const text = content.recipe;
  const missing = Number(!text.image) + text.ingredients.filter(item => !content.photos.ingredients[item.id]?.src).length + text.steps.filter(item => isStepPhotoRequired(content, item.id) && !content.photos.steps[item.id]?.src).length;
  if (missing > 0 && batch && ['blocked', 'failed'].includes(batch.status)) return { ...base, kind: 'generation_problem', priority: 0,
    description: 'Pakiet zdjęć wymaga uwagi. Sprawdź istniejące wyniki i wznowienie.', href: `/admin/ai?recipe=${encodeURIComponent(recipe.id)}`, actionLabel: 'Sprawdź pakiet zdjęć', updatedAt: batch.updatedAt.toISOString() };
  const blocking = jobs.find(job => ['queued', 'submitting', 'generating'].includes(job.status));
  if (blocking) {
    return { ...base, kind: 'generating', priority: 5, description: 'Przygotowanie trwa. Gotowe wyniki są zachowane.',
      href: `/admin/ai/${encodeURIComponent(blocking.id)}`, actionLabel: 'Zobacz postęp', updatedAt: blocking.updatedAt.toISOString() };
  }
  const failed = [...currentJobs.values()].find(job => job.status === 'failed' && job.baseRevision >= recipe.revision);
  if (failed) return { ...base, kind: 'generation_problem', priority: 0, description: 'Przygotowanie wymaga sprawdzenia. Zacznij od istniejącego wyniku.',
    href: `/admin/ai/${encodeURIComponent(failed.id)}`, actionLabel: 'Sprawdź wynik', updatedAt: failed.updatedAt.toISOString() };
  // Review/audit actions advance revisions without changing the public content.
  if (recipe.publicationStatus === 'published' && !recipe.hasUnpublishedChanges) return null;
  if (!text.ingredients.length || !text.steps.length || !text.description.pl.trim()) return { ...base, kind: 'draft', priority: 4, description: 'Szkic wymaga składników i sposobu przygotowania.', actionLabel: 'Dokończ treść' };
  if (!contentApproved) return { ...base, kind: 'content_review', priority: 1, description: 'Przeczytaj obie wersje językowe i zaakceptuj bieżącą treść.', actionLabel: 'Sprawdź treść' };
  if (missing) return { ...base, kind: 'photos', priority: 2, description: `Do uzupełnienia: ${missing} zdjęć. Zachowamy gotowe fotografie.`, actionLabel: 'Dokończ zdjęcia' };
  return { ...base, kind: 'ready', priority: 3, description: 'Treść zaakceptowana i zdjęcia kompletne. Sprawdź podgląd oraz potwierdź publikację.', actionLabel: 'Sprawdź i opublikuj' };
}

export function sortAdminAttention(items: AdminAttentionItem[]) {
  return [...items].sort((a, b) => a.priority - b.priority || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id));
}
