import 'server-only';
import Decimal from 'decimal.js';
import { asc, sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { aiJobs } from '@/server/ai/schema';
import { trendRuns } from '@/server/trends/schema';
import { recipeCosts } from '@/lib/publication-costs';
import { ingredientVerifications } from '@/server/ai/ingredient-dictionary-store';
export async function getPublicationCosts() {
  const db = getDb();
  const [recipes, jobs, research, verification] = await Promise.all([
    db.select({ id: editorialRecipes.id, title: sql<string>`${editorialRecipes.content}->'recipe'->'title'->>'pl'`, published: sql<boolean>`EXISTS(SELECT 1 FROM editorial_publication p WHERE p.recipe_id=${editorialRecipes.id})` }).from(editorialRecipes),
    db.select({ recipeId: aiJobs.recipeId, kind: aiJobs.kind, targetId: aiJobs.targetId, reservedUsd: aiJobs.reservedUsd, chargedUsd: aiJobs.chargedUsd, costBasis: aiJobs.costBasis, providerRequestId: aiJobs.providerRequestId }).from(aiJobs).orderBy(asc(aiJobs.createdAt)),
    db.select({ recipeId: trendRuns.recipeId, reservedUsd: trendRuns.searchReservedUsd, chargedUsd: trendRuns.searchChargedUsd, packetRemainingUsd: trendRuns.packetRemainingUsd }).from(trendRuns),
    db.select({ recipeId: ingredientVerifications.originRecipeId, chargedUsd: sql<string>`coalesce(sum(CASE WHEN ${ingredientVerifications.costBasis}='usage' THEN ${ingredientVerifications.chargedUsd} ELSE 0 END),0)::text`, pendingCount: sql<number>`count(*) filter(where ${ingredientVerifications.chargedUsd} IS NULL OR ${ingredientVerifications.costBasis} IS DISTINCT FROM 'usage')::int` }).from(ingredientVerifications).groupBy(ingredientVerifications.originRecipeId),
  ]);
  const verificationByRecipe = new Map(verification.map(item => [item.recipeId, item]));
  const rows = recipes.map(recipe => recipeCosts({ recipeId: recipe.id, title: recipe.title || 'Bez tytułu', published: recipe.published, jobs: jobs.filter(job => job.recipeId === recipe.id), research: research.filter(run => run.recipeId === recipe.id), verification: verificationByRecipe.get(recipe.id) }));
  const recipeIds = new Set(recipes.map(recipe => recipe.id));
  const unassignedVerification = verification.filter(item => !item.recipeId || !recipeIds.has(item.recipeId));
  const unassigned = recipeCosts({ recipeId: '', title: 'Research bez przepisu', published: false, jobs: [], research: research.filter(run => !run.recipeId), verification: {
    chargedUsd: unassignedVerification.reduce((sum, item) => sum.plus(item.chargedUsd), new Decimal(0)).toFixed(8), pendingCount: unassignedVerification.reduce((sum, item) => sum + item.pendingCount, 0),
  } });
  return [...rows, ...(research.some(run => !run.recipeId) || unassignedVerification.length ? [unassigned] : [])];
}
