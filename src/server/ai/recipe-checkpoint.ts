import 'server-only';
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Response } from 'openai/resources/responses/responses';
import type { Ingredient } from '@/lib/recipes';
import { normalizeIngredientVerificationName } from '@/lib/ingredient-verification';
import type { VerifiedIngredientDictionary, RecipeDietId } from '@/lib/recipe-diet';
import { getDb } from '@/server/db';
import { aiJobs } from './schema';
import { recipeResponses, recipeManualRepairs, type ReviewedRecipeIngredient } from './recipe-checkpoint-schema';
import type { AiTransaction } from './store';
import { AiError } from './errors';
import { ProviderError } from './provider-error';

type Database = ReturnType<typeof getDb> | AiTransaction;

export async function getRecipeResponse(requestId: string, db: Database = getDb()) {
  const [saved] = await db.select().from(recipeResponses).where(eq(recipeResponses.requestId, requestId)).limit(1);
  if (!saved) return null;
  if (saved.response.id !== requestId || saved.response.status !== 'completed'
    || createHash('sha256').update(JSON.stringify(canonicalResponse(saved.response))).digest('hex') !== saved.digest)
    throw new ProviderError('AI_CHECKPOINT_INVALID', 'Zapisany wynik nie przeszedł kontroli integralności. Zachowano historię i zablokowano nowe generowanie.', true);
  return saved.response;
}

/** Called only for an exact, completed receipt. Never overwrite provider evidence. */
export async function retainRecipeResponse(jobId: string, response: Response) {
  const db = getDb();
  const [job] = await db.select({ requestId: aiJobs.providerRequestId, kind: aiJobs.kind }).from(aiJobs).where(eq(aiJobs.id, jobId));
  if (!job || job.kind !== 'recipe' || response.id !== job.requestId || response.status !== 'completed')
    throw new ProviderError('AI_CHECKPOINT_RECEIPT_MISMATCH', 'Nie potwierdzono tożsamości zapisywanego wyniku.', true);
  // PostgreSQL jsonb canonicalises key order. Hash that same representation on reads.
  const canonical = canonicalResponse(response);
  await db.insert(recipeResponses).values({ jobId, requestId: response.id, response: canonical,
    digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }).onConflictDoNothing();
  const saved = await getRecipeResponse(response.id);
  if (!saved) throw new ProviderError('AI_PROVIDER_STATUS_UNAVAILABLE', 'Nie zapisano punktu wznowienia przepisu. Ponów odczyt tego samego wyniku.', true);
}

export function canonicalResponse<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonicalResponse) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalResponse(item)])) as T;
  return value;
}

export async function latestManualRecipeRepair(jobId: string, db: Database = getDb()) {
  const [repair] = await db.select().from(recipeManualRepairs).where(eq(recipeManualRepairs.jobId, jobId)).orderBy(desc(recipeManualRepairs.version)).limit(1);
  return repair ?? null;
}

export function reviewedIngredientDictionary(ingredients: readonly Pick<Ingredient, 'id' | 'name'>[], reviews: readonly ReviewedRecipeIngredient[], base: VerifiedIngredientDictionary = new Map()): VerifiedIngredientDictionary {
  const dictionary = new Map<string, RecipeDietId>(base);
  const reviewedNames = new Set(base.reviewedNames);
  for (const review of reviews) {
    const ingredient = ingredients.find(item => item.id === review.ingredientId);
    if (!ingredient || !['pl', 'en'].every(locale => ingredient.name[locale as 'pl' | 'en'] === review.name[locale as 'pl' | 'en'])) continue;
    for (const name of Object.values(review.name).map(normalizeIngredientVerificationName).filter(Boolean)) {
      dictionary.set(name, review.diet); reviewedNames.add(name);
    }
  }
  return Object.assign(dictionary, { reviewedNames });
}

/** Human decisions are scoped to one recipe and the exact reviewed ingredient pair. */
export async function recipeReviewedAliases(recipeId: string, ingredients: readonly Pick<Ingredient, 'id' | 'name'>[], base: VerifiedIngredientDictionary, db: Database = getDb()) {
  const rows = await db.select().from(recipeManualRepairs).where(eq(recipeManualRepairs.recipeId, recipeId)).orderBy(desc(recipeManualRepairs.createdAt), desc(recipeManualRepairs.version));
  const seenJobs = new Set<string>(), seen = new Set<string>(), reviews: ReviewedRecipeIngredient[] = [];
  for (const row of rows) {
    if (seenJobs.has(row.jobId)) continue;
    seenJobs.add(row.jobId);
    for (const review of row.reviewedIngredients) {
      const identity = JSON.stringify([review.ingredientId, review.name]);
      if (!seen.has(identity)) { seen.add(identity); reviews.push(review); }
    }
  }
  return reviewedIngredientDictionary(ingredients, reviews, base);
}

export function recipeResponseCheckpoint(jobId: string) {
  return {
    read: getRecipeResponse,
    retain: (response: Response) => retainRecipeResponse(jobId, response),
    proposal: async () => (await latestManualRecipeRepair(jobId))?.proposal ?? null,
  };
}

export function checkpointConflict(): never {
  throw new AiError(409, 'RECIPE_REPAIR_CONFLICT', 'Zachowany wynik zmienił się w innym oknie. Wczytaj aktualny punkt wznowienia.');
}
