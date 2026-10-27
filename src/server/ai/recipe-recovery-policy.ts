import type { AiJob, AiStatus } from '@/lib/ai-types';

export const recipeRepairLimit = 2;
export const recipeRepairBackoff = ['10s', '1m'] as const;
export type RecipeValidationIssue = { field: string; message: string; code?: string };

const unrecognisedDietMessage = 'Unrecognised ingredient: its dietary suitability needs an explicit review or a more precise ingredient name.';

/** A missing local dictionary entry cannot be repaired by buying another recipe. */
export function hasUnrecognisedDietaryIngredient(issues: readonly RecipeValidationIssue[]): boolean {
  return issues.some(issue => /^ingredients\.[^.]+\.name$/.test(issue.field)
    && (issue.code !== undefined ? issue.code === 'DIET_INGREDIENT_UNRECOGNISED' : issue.message.includes(unrecognisedDietMessage)));
}

export function recipeIssuesAllowAutomaticRepair(issues: readonly RecipeValidationIssue[]): boolean {
  return issues.length > 0 && !hasUnrecognisedDietaryIngredient(issues);
}

export function recipeValidationIssues(issues: readonly RecipeValidationIssue[] = []): RecipeValidationIssue[] {
  return issues.filter(issue => typeof issue.field === 'string' && typeof issue.message === 'string')
    .slice(0, 20).map(issue => ({ field: issue.field.slice(0, 160), message: issue.message.slice(0, 500),
      ...(typeof issue.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(issue.code) ? { code: issue.code } : {}) }));
}

export function confirmedInvalidRecipe(job: {
  kind: string; provider: string; status: AiStatus; errorCode: string | null;
  providerRequestId: string | null; providerFinishedAt: Date | null;
  costBasis: string | null; chargedUsd: string | null; result: unknown;
}) {
  return job.kind === 'recipe' && job.provider === 'openai' && job.status === 'failed'
    && job.errorCode === 'AI_RESULT_INVALID' && Boolean(job.providerRequestId && job.providerFinishedAt)
    && job.costBasis === 'usage' && job.chargedUsd !== null && !job.result;
}

export function recipeReceiptCanBeRead(job: {
  kind: string; provider: string; status: AiStatus; errorCode: string | null;
  providerRequestId: string | null; result: unknown;
}) {
  return job.kind === 'recipe' && job.provider === 'openai' && Boolean(job.providerRequestId) && !job.result
    && (job.status === 'uncertain' || job.status === 'failed' && job.errorCode === 'AI_RESULT_INVALID');
}

export function recipeGetRetryable(code: string) {
  return ['AI_PROVIDER_STATUS_UNAVAILABLE', 'AI_PROVIDER_STATUS_TEMPORARILY_UNAVAILABLE', 'AI_RESULT_UNCONFIRMED'].includes(code);
}

export function recipeRecoveryReason(code: string | null) {
  if (code && /(?:AUTH|CONFIGURATION|MODEL_NOT_APPROVED|QUOTA|CREDITS|PAYMENT|PROVIDER_REJECTED)/.test(code))
    return 'Usługa treści wymaga sprawdzenia dostępu, salda lub limitu. Przywróć usługę, a następnie ponów odczyt istniejącego zlecenia.';
  if (code && /(?:SUBMISSION_UNCERTAIN|DISPATCH_UNCONFIRMED)/.test(code))
    return 'Nie potwierdzono przyjęcia żądania. Zachowano identyfikator zgłoszenia; nowa płatna generacja jest zablokowana.';
  return 'Zachowano istniejące zlecenie i jego koszt. Można ponowić odczyt tego samego wyniku bez nowej generacji.';
}

export type RecipeRecoveryDto = NonNullable<AiJob['recovery']>;
