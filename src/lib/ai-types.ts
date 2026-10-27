import type { EditorialContent, EditorialRecord } from './editorial-types';
import type { Localised } from './recipes';
import type { MediaTile } from './recipe-media';
import type { HeroContainer } from './hero-presentation';

export const ingredientCutoutRecoveryBrief = '[ingredient-cutout-v2] Wytnij tło zakończonej fotografii składnika, wskazując jego widoczne naczynie. Zachowaj cały produkt i naczynie. Bez ponownego generowania zdjęcia.';
export const heroCutoutSemanticRetryBrief = '[hero-cutout-v2] Wytnij tło zachowanej fotografii, wskazując samo naczynie. Zachowaj całą potrawę i naczynie. Bez ponownego generowania zdjęcia.';

export const aiKinds = ['recipe', 'hero', 'ingredient', 'step'] as const;
export type AiKind = typeof aiKinds[number];
export type AiStatus = 'queued' | 'submitting' | 'generating' | 'ready' | 'failed' | 'uncertain' | 'cancelled' | 'applied';
export type AiProvider = 'openai' | 'fal';
export type AiAsset = {
  id: string; recipeId: string; jobId: string; kind: Exclude<AiKind, 'recipe'>;
  targetId: string | null; src: string; width: number; height: number;
  alt: Localised; caption: Localised; model: string; createdAt: string; styleProfile?: string;
};
export type AiResult = { content: EditorialContent | null; asset: AiAsset | null; notes: string[]; reusedPhoto?: MediaTile & { styleProfile?: string }; derivation?: { method: 'builtin_image_background_edit' | 'reviewed_ingredient_reuse'; sourceJobId: string; sourceAssetId: string; sha256: string } | { method: 'deterministic_hero_mask_repair' | 'builtin_hero_background_edit'; sourceJobId: string; sourceAssetId: string; sha256: string; sourceSha256: string }; reuse?: { source: 'library' | 'shared_generation'; key: string } };
export type AiJob = {
  id: string; recipeId: string; recipeTitle: string; baseRevision: number;
  kind: AiKind; targetId: string | null; status: AiStatus;
  provider: AiProvider; model: string; brief: string; createdByName: string;
  createdAt: string; updatedAt: string; providerRequestId: string | null;
  reservedUsd: string; chargedUsd: string | null; costBasis: 'usage' | 'reservation' | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  errorCode: string | null; errorMessage: string | null;
  result: AiResult | null; appliedRevision: number | null;
  reuseSourceJobId?: string | null;
  heroContainer?: HeroContainer;
  photoRecovery?: {
    jobId: string; status: AiStatus; errorCode: string | null;
    chargedUsd: string | null; costBasis: 'usage' | 'reservation' | null;
  };
  photoSourceJobId?: string;
  photoSourceStatus?: 'ready' | 'applied';
  manualPhotoComposition?: boolean;
  canRetryPhotoMask?: boolean;
  canRestorePhotoContents?: boolean;
  recovery?: {
    status: 'recovering' | 'ready' | 'exhausted' | 'blocked';
    attempt: number; maxAttempts: number; reason?: string; code?: string;
    issues?: { field: string; message: string }[];
    canResume?: boolean; jobId?: string;
  };
};
export type AiBudget = {
  pendingCostCount?: number;
  dailyLimitUsd: string; monthlyLimitUsd: string; pilotLimitUsd: string;
  dailyUsedUsd: string; monthlyUsedUsd: string; pilotUsedUsd: string;
  reservedUsd: string; activeJobs: number; concurrentLimit: number;
  /** Used includes settled costs and held reservations; reservations are also broken down by UTC period. */
  dailyReservedUsd?: string; monthlyReservedUsd?: string; pilotReservedUsd?: string;
  limitsEnforced?: boolean; bypassUntil?: string | null; settingsRevision?: number; serverNow?: string;
};
export type AiConfiguration = {
  openai: boolean; fal: boolean; storage: boolean;
  recipeModel: string; imageModel: string;
  recipeReservationUsd: string; imageReservationUsd: string;
  heroCutoutReservationUsd?: string;
  whiteIngredientReservationUsd?: string;
  paperIngredientReservationUsd?: string;
  budget: AiBudget;
};
export type CreateAiJob = { recipeId: string; expectedRevision: number; kind: AiKind; targetId?: string; brief: string; requestKey: string; regenerate?: boolean; imageAction?: 'remove_background' | 'crop_step' | 'fill_cutout' | 'cutout_result'; sourceJobId?: string };
export type ApplyAiJob = { expectedRevision: number; acknowledgeStale: boolean };
export type ApplyAiResult = { job: AiJob; recipe: EditorialRecord };
