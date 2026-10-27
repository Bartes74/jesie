export const approvedImageModel = 'openai/gpt-image-2.5/sunburst/text-to-image';
export const heroCutoutModel = 'fal-ai/sam-3/image';
export const heroCutoutReservationUsd = '0.00000000';
export const stepFormatModel = 'jesie/step-photo-21-9';
export const filledHeroModel = 'jesie/hero-cutout-filled';
export const failedHeroSourcePrefix = '/ai-result/';
export const heroMaskPromptVersion = 'vessel-noun-v1' as const;
export const glassHeroMaskPromptVersion = 'vessel-contents-v2' as const;
export const heroCenterFoodRejectionMessage = 'Wycięcie usuwa środek potrawy lub naczynia. Zachowano oryginał; sprawdź całą potrawę przed zapisem.';

/** Reprocess this same accepted mask after the conservative interior-fill fix. */
export function canRestoreHeroContents(source: Omit<FailedHeroSource, 'input'> & {
  input?: { recipe: { image: string; heroPresentation?: { container?: string } | null }; aiPhotography?: { heroMaskPromptVersion?: string; heroPresentationOverride?: { container?: string } } };
  errorMessage: string | null; chargedUsd: string | null; costBasis: string | null;
}) {
  const container = source.input?.aiPhotography?.heroPresentationOverride?.container ?? source.input?.recipe.heroPresentation?.container;
  return Boolean(source.kind === 'hero' && source.provider === 'fal' && source.model === heroCutoutModel && source.status === 'failed'
    && source.errorCode === 'AI_IMAGE_INVALID' && source.errorMessage === heroCenterFoodRejectionMessage
    && source.providerRequestId && /^[A-Za-z0-9_-]{1,100}$/.test(source.providerRequestId) && source.providerFinishedAt
    && source.result === null && source.appliedRevision === null && source.costBasis === 'usage'
    && source.chargedUsd !== null && /^\d+(?:\.\d{1,8})?$/.test(source.chargedUsd) && Number(source.chargedUsd) > 0
    && source.input?.aiPhotography?.heroMaskPromptVersion === heroMaskPromptVersion
    && ['clay-pot', 'pot', 'pan', 'baking-dish'].includes(container ?? '')
    && /^\/ai-result\/[a-f0-9-]{36}$/i.test(source.input?.recipe.image ?? ''));
}

/** One owner's changed semantic prompt may repair a billed legacy empty mask. */
export function canRetryMissingHeroMask(source: Omit<FailedHeroSource, 'input'> & { input?: { recipe: { image: string }; aiPhotography?: { heroMaskPromptVersion?: string } }; brief: string; errorMessage: string | null; chargedUsd: string | null; costBasis: string | null }, brief: string, sourceJobId: string) {
  return Boolean(source.kind === 'hero' && source.provider === 'fal' && source.model === heroCutoutModel
    && source.status === 'failed' && source.providerRequestId && source.providerFinishedAt
    && source.result === null && source.appliedRevision === null
    && source.costBasis === 'usage' && source.chargedUsd !== null && /^\d+(?:\.\d{1,8})?$/.test(source.chargedUsd) && Number(source.chargedUsd) > 0
    && source.input?.recipe.image === `${failedHeroSourcePrefix}${sourceJobId}` && !source.input.aiPhotography?.heroMaskPromptVersion
    && brief === heroCutoutSemanticRetryBrief && source.brief !== heroCutoutSemanticRetryBrief
    && (source.errorCode === 'AI_MASK_NOT_FOUND' || source.errorCode === 'AI_IMAGE_INVALID' && source.errorMessage === 'Dostawca nie zwrócił maski wycięcia.'));
}

/** One owner-requested semantic correction after a confirmed empty mask, never a transport retry. */
export function canRetryMissingIngredientMask(source: FailedHeroSource & { brief: string; errorMessage: string | null }, brief: string, ingredientKey: string) {
  return Boolean(source.kind === 'ingredient' && source.provider === 'fal' && source.model === heroCutoutModel
    && source.status === 'failed' && source.providerRequestId && source.providerFinishedAt
    && source.result === null && source.appliedRevision === null && source.ingredientKey === ingredientKey
    && brief === ingredientCutoutRecoveryBrief && source.brief !== ingredientCutoutRecoveryBrief
    && (source.errorCode === 'AI_MASK_NOT_FOUND' || source.errorCode === 'AI_IMAGE_INVALID' && source.errorMessage === 'Dostawca nie zwrócił maski wycięcia.'));
}

export type FailedHeroSource = {
  id: string; recipeId: string; kind: string; provider: string; model: string; status: string;
  providerRequestId: string | null; providerFinishedAt: Date | null; errorCode: string | null;
  result: unknown; appliedRevision: number | null;
  targetId?: string | null; ingredientKey?: string | null; input?: EditorialContent;
};
export type CutoutKind = 'hero' | 'ingredient';
export function isRecoverablePhotoSource(source: FailedHeroSource | null | undefined, recipeId: string, kind: CutoutKind, targetId: string | null = null, ingredient?: Ingredient): source is FailedHeroSource & { providerRequestId: string } {
  const completed = Boolean(source && /^[a-f0-9-]{36}$/i.test(source.id) && source.recipeId === recipeId && source.kind === kind
    && source.provider === 'fal' && source.model === approvedImageModel && source.status === 'failed'
    && source.errorCode === 'AI_TRANSPARENCY_MISSING' && source.providerFinishedAt && source.result === null
    && source.appliedRevision === null && source.providerRequestId && /^[A-Za-z0-9_-]{1,100}$/.test(source.providerRequestId));
  if (!completed || !source) return false;
  if (kind === 'hero') return true;
  const original = source.input?.recipe.ingredients.find(item => item.id === targetId);
  return Boolean(targetId && source.targetId === targetId && original && ingredient && ingredient.id === targetId
    && source.input?.recipe.id === recipeId && source.ingredientKey
    && source.ingredientKey === ingredientImageIdentity(original).key
    && source.ingredientKey === ingredientImageIdentity(ingredient).key);
}
export function isRecoverableHeroSource(source: FailedHeroSource | null | undefined, recipeId: string): source is FailedHeroSource & { providerRequestId: string } {
  return isRecoverablePhotoSource(source, recipeId, 'hero');
}
import type { EditorialContent } from '@/lib/editorial-types';
import type { Ingredient } from '@/lib/recipes';
import { ingredientImageIdentity } from './ingredient-profile';
import { heroCutoutSemanticRetryBrief, ingredientCutoutRecoveryBrief } from '@/lib/ai-types';
