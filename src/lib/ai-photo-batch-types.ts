import type { AiJob } from './ai-types';
import type { EditorialRecord } from './editorial-types';

export type AiPhotoKind = 'hero' | 'ingredient' | 'step';
export type AiPhotoBatchStatus = 'queued' | 'generating' | 'ready' | 'blocked' | 'failed' | 'applied';
export type AiPhotoBatchSlot = {
  kind: AiPhotoKind;
  targetId: string | null;
  label: string;
  status: 'pending' | AiJob['status'];
  job: AiJob | null;
};
export type AiPhotoBatch = {
  id: string;
  mode: 'missing' | 'ingredients-white' | 'ingredients-paper';
  recipeId: string;
  recipeTitle: string;
  baseRevision: number;
  generation?: number;
  sourceJobId: string | null;
  status: AiPhotoBatchStatus;
  slots: AiPhotoBatchSlot[];
  progress: { completed: number; failed: number; total: number };
  canResume: boolean;
  canApply: boolean;
  reservedUsd: string;
  remainingReservedUsd: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  appliedRevision: number | null;
};
export type CreateAiPhotoBatch = { recipeId: string; expectedRevision: number; requestKey: string; sourceJobId?: string; mode?: 'missing' | 'ingredients-white' | 'ingredients-paper'; ingredientIds?: string[] };
export type ApplyAiPhotoBatchResult = { batch: AiPhotoBatch; recipe: EditorialRecord };
