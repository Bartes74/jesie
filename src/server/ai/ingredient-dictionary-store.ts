import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Decimal from 'decimal.js';
import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { boolean, jsonb, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { getDb } from '@/server/db';
import { aiJobs } from './schema';
import type { AiTransaction } from './store';
import type { RecipeDietId } from '@/lib/recipe-diet';
import { ingredientEvidencePolicyVersion, ingredientVerificationInputSchema, ingredientVerificationResultSchema, normalizeIngredientVerificationName,
  type IngredientVerificationInput, type IngredientVerificationResult } from '@/lib/ingredient-verification';

type Database = ReturnType<typeof getDb> | AiTransaction;
export type VerificationCost = { chargedUsd?: string | null; costBasis?: 'usage' | 'reservation'; usage?: { inputTokens: number; outputTokens: number } | null };
export const ingredientVerifications = pgTable('ai_ingredient_verification', {
  key: text('verification_key').primaryKey(), input: jsonb('input').$type<IngredientVerificationInput>().notNull(), model: text('model').notNull(),
  originJobId: text('origin_job_id').references(() => aiJobs.id, { onDelete: 'set null' }), originRecipeId: text('origin_recipe_id'),
  status: text('status').$type<'submitting' | 'generating' | 'complete' | 'uncertain' | 'failed'>().notNull(),
  claimToken: text('claim_token').notNull(), claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }).notNull(),
  providerRequestId: text('provider_request_id'), result: jsonb('result').$type<IngredientVerificationResult>(), learned: boolean('learned').notNull(),
  eligibilityPolicyVersion: text('eligibility_policy_version').notNull(),
  chargedUsd: numeric('charged_usd', { precision: 16, scale: 8 }), costBasis: text('cost_basis').$type<'usage' | 'reservation'>(),
  usage: jsonb('usage').$type<{ inputTokens: number; outputTokens: number }>(), errorCode: text('error_code'), errorMessage: text('error_message'),
  providerFinishedAt: timestamp('provider_finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const verifiedIngredientAliases = pgTable('ai_verified_ingredient_alias', {
  normalizedAlias: text('normalized_alias').primaryKey(), verificationKey: text('verification_key').notNull().references(() => ingredientVerifications.key),
  diet: text('diet').$type<RecipeDietId>().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export type IngredientVerificationRecord = typeof ingredientVerifications.$inferSelect;
// Identity is intentionally independent from evidence-policy revisions: an
// eligibility recheck must reuse the original paid request and its receipt.
const identityVersion = 'ingredient-evidence-v1';
const leaseMilliseconds = 120_000;

/** Notes cannot turn the same unknown name into another paid request. */
export function ingredientVerificationKey(value: IngredientVerificationInput): string {
  const input = ingredientVerificationInputSchema.parse(value);
  const names = [...new Set(Object.values(input.name).map(normalizeIngredientVerificationName).filter(Boolean))].sort();
  if (!names.length) throw new Error('INGREDIENT_VERIFICATION_NAME_REQUIRED');
  return createHash('sha256').update(JSON.stringify([identityVersion, names])).digest('hex');
}

function checkedKey(key: string) { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('INGREDIENT_VERIFICATION_KEY_INVALID'); return key; }
async function lock(db: AiTransaction, key: string) { await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ingredient-verification:${key}`}))`); }
async function locked(db: AiTransaction, key: string) {
  await lock(db, checkedKey(key));
  const [record] = await db.select().from(ingredientVerifications).where(eq(ingredientVerifications.key, key)).for('update');
  if (!record) throw new Error('INGREDIENT_VERIFICATION_NOT_FOUND');
  return record;
}
function owned(record: IngredientVerificationRecord, claimToken: string) { if (record.claimToken !== claimToken) throw new Error('INGREDIENT_VERIFICATION_CLAIM_MISMATCH'); }
function receipt(record: IngredientVerificationRecord, providerRequestId: string) {
  if (!providerRequestId || !/^resp_[A-Za-z0-9_-]{1,490}$/.test(providerRequestId) || record.providerRequestId !== providerRequestId) throw new Error('INGREDIENT_VERIFICATION_RECEIPT_MISMATCH');
}
function costUpdate(record: IngredientVerificationRecord, cost: VerificationCost = {}) {
  if (cost.usage && (![cost.usage.inputTokens, cost.usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0))) throw new Error('INGREDIENT_VERIFICATION_USAGE_INVALID');
  let chargedUsd: string | null = null;
  if (cost.chargedUsd !== undefined && cost.chargedUsd !== null) {
    if (!/^\d+(?:\.\d{1,8})?$/.test(cost.chargedUsd)) throw new Error('INGREDIENT_VERIFICATION_COST_INVALID');
    const value = new Decimal(cost.chargedUsd);
    if (!value.isFinite() || value.lt(0)) throw new Error('INGREDIENT_VERIFICATION_COST_INVALID');
    chargedUsd = value.toFixed(8);
  }
  const costBasis = chargedUsd === null ? null : cost.costBasis ?? 'usage';
  if (record.costBasis === 'usage' && record.chargedUsd !== null) {
    if (chargedUsd !== null && (chargedUsd !== record.chargedUsd || costBasis !== record.costBasis)) throw new Error('INGREDIENT_VERIFICATION_COST_CONFLICT');
    return { chargedUsd: record.chargedUsd, costBasis: record.costBasis, usage: record.usage ?? cost.usage ?? null };
  }
  return { chargedUsd: chargedUsd ?? record.chargedUsd, costBasis: costBasis ?? record.costBasis, usage: cost.usage ?? record.usage };
}

export async function getVerification(key: string, db: Database = getDb()): Promise<IngredientVerificationRecord | null> {
  const [record] = await db.select().from(ingredientVerifications).where(eq(ingredientVerifications.key, checkedKey(key)));
  return record ?? null;
}

export async function startOrClaimVerification(value: IngredientVerificationInput, options: { originJobId?: string | null; originRecipeId?: string | null; model?: string } = {}) {
  const input = ingredientVerificationInputSchema.parse(value), key = ingredientVerificationKey(input);
  return getDb().transaction(async tx => {
    await lock(tx, key);
    const [existing] = await tx.select().from(ingredientVerifications).where(eq(ingredientVerifications.key, key)).for('update');
    if (existing) {
      if (existing.status === 'submitting' && !existing.providerRequestId && existing.claimExpiresAt.getTime() <= Date.now()) {
        const [uncertain] = await tx.update(ingredientVerifications).set({ status: 'uncertain', errorCode: 'INGREDIENT_VERIFICATION_SUBMISSION_UNCONFIRMED',
          errorMessage: 'Nie potwierdzono przyjęcia weryfikacji. Zachowano zgłoszenie; kolejna płatna próba jest zablokowana.', updatedAt: new Date() })
          .where(eq(ingredientVerifications.key, key)).returning();
        return { verification: uncertain, claimed: false as const };
      }
      return { verification: existing, claimed: false as const };
    }
    const now = new Date(), claimToken = randomUUID();
    const [verification] = await tx.insert(ingredientVerifications).values({ key, input, model: options.model ?? 'gpt-6.1-sol',
      originJobId: options.originJobId ?? null, originRecipeId: options.originRecipeId ?? null, status: 'submitting', claimToken,
      claimExpiresAt: new Date(now.getTime() + leaseMilliseconds), eligibilityPolicyVersion: ingredientEvidencePolicyVersion, learned: false, createdAt: now, updatedAt: now }).returning();
    return { verification, claimed: true as const, claimToken };
  });
}

export async function attachReceipt(key: string, claimToken: string, providerRequestId: string) {
  if (!/^resp_[A-Za-z0-9_-]{1,490}$/.test(providerRequestId)) throw new Error('INGREDIENT_VERIFICATION_RECEIPT_INVALID');
  return getDb().transaction(async tx => {
    const record = await locked(tx, key); owned(record, claimToken);
    if (record.providerRequestId) { receipt(record, providerRequestId); return record; }
    if (!['submitting', 'uncertain'].includes(record.status)) throw new Error('INGREDIENT_VERIFICATION_NOT_SUBMITTABLE');
    const [updated] = await tx.update(ingredientVerifications).set({ providerRequestId, status: 'generating', errorCode: null, errorMessage: null, updatedAt: new Date() })
      .where(eq(ingredientVerifications.key, key)).returning();
    return updated;
  });
}

function resultAliases(record: IngredientVerificationRecord, result: IngredientVerificationResult) {
  if (!result.autoLearnEligible) return [];
  const expected: Partial<Record<IngredientVerificationResult['kind'], RecipeDietId>> = { plant: 'vegan', fungus: 'vegan', mineral: 'vegan', dairy: 'vegetarian', egg: 'vegetarian', honey: 'vegetarian', meat: 'meat' };
  if (result.decision !== 'verified' || result.confidence !== 'high' || !result.sameIdentity || !result.singleIngredient || !result.canonicalName || expected[result.kind] !== result.diet)
    throw new Error('INGREDIENT_VERIFICATION_LEARNING_INELIGIBLE');
  const domains = new Set(result.sources.map(source => { const url = new URL(source.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INGREDIENT_VERIFICATION_SOURCE_INVALID'); return url.hostname.replace(/^www\./, ''); }));
  if (domains.size < 2) throw new Error('INGREDIENT_VERIFICATION_SOURCES_INSUFFICIENT');
  // Only the queried names passed the evidence check. A suggested canonical
  // label must not silently expand the dictionary to another spelling.
  return [...new Set(Object.values(record.input.name).map(normalizeIngredientVerificationName).filter(Boolean))].sort();
}

export async function completeVerification(key: string, providerRequestId: string, value: IngredientVerificationResult, cost: VerificationCost = {}) {
  const result = ingredientVerificationResultSchema.parse(value);
  return getDb().transaction(async tx => {
    const record = await locked(tx, key); receipt(record, providerRequestId);
    if (!isDeepStrictEqual(result.queriedNames, record.input.name)) throw new Error('INGREDIENT_VERIFICATION_QUERY_MISMATCH');
    if (record.result) {
      const { autoLearnEligible: previousEligibility, ...previousFacts } = record.result;
      const { autoLearnEligible: nextEligibility, ...nextFacts } = result;
      if (!isDeepStrictEqual(previousFacts, nextFacts) || previousEligibility && !nextEligibility) throw new Error('INGREDIENT_VERIFICATION_RESULT_CONFLICT');
    }
    const costs = costUpdate(record, cost);
    const eligibilityChanged = record.result?.autoLearnEligible !== result.autoLearnEligible;
    if (record.status === 'complete' && record.eligibilityPolicyVersion === ingredientEvidencePolicyVersion && !eligibilityChanged) {
      const [updated] = await tx.update(ingredientVerifications).set({ ...costs, updatedAt: new Date() }).where(eq(ingredientVerifications.key, key)).returning();
      return updated;
    }
    const aliases = resultAliases(record, result);
    // Serialize overlapping queried aliases too, in a stable order.
    for (const alias of aliases) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ingredient-alias:${alias}`}))`);
    const existing = aliases.length ? await tx.select().from(verifiedIngredientAliases).where(inArray(verifiedIngredientAliases.normalizedAlias, aliases)) : [];
    const conflict = existing.some(alias => alias.verificationKey !== key || alias.diet !== result.diet);
    if (!conflict && aliases.length) await tx.insert(verifiedIngredientAliases).values(aliases.map(normalizedAlias => ({ normalizedAlias, verificationKey: key, diet: result.diet!, createdAt: new Date() }))).onConflictDoNothing();
    const [updated] = await tx.update(ingredientVerifications).set({ ...costs, result, eligibilityPolicyVersion: ingredientEvidencePolicyVersion, status: 'complete', learned: aliases.length > 0 && !conflict,
      errorCode: conflict ? 'INGREDIENT_ALIAS_CONFLICT' : null, errorMessage: conflict ? 'Potwierdzona nazwa jest już przypisana do innego wpisu. Nie zmieniono słownika.' : null,
      providerFinishedAt: record.providerFinishedAt ?? new Date(), updatedAt: new Date() }).where(eq(ingredientVerifications.key, key)).returning();
    return updated;
  });
}

async function recordFailure(key: string, claimToken: string, status: 'uncertain' | 'failed', error: { code: string; message: string }, cost: VerificationCost = {}) {
  return getDb().transaction(async tx => {
    const record = await locked(tx, key); owned(record, claimToken);
    if (record.status === 'complete') return record;
    const [updated] = await tx.update(ingredientVerifications).set({ ...costUpdate(record, cost), status,
      errorCode: error.code.slice(0, 100), errorMessage: error.message.slice(0, 1000),
      ...(status === 'failed' ? { providerFinishedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(ingredientVerifications.key, key)).returning();
    return updated;
  });
}
export async function markUncertain(key: string, claimToken: string, error: { code: string; message: string }, cost?: VerificationCost) { return recordFailure(key, claimToken, 'uncertain', error, cost); }
export async function failVerification(key: string, claimToken: string, error: { code: string; message: string }, cost?: VerificationCost) { return recordFailure(key, claimToken, 'failed', error, cost); }

export async function lookupExactAliasRecords(names: readonly string[], db: Database = getDb()): Promise<ReadonlyMap<string, { diet: RecipeDietId; verificationKey: string }>> {
  const aliases = [...new Set(names.map(normalizeIngredientVerificationName).filter(Boolean))];
  if (!aliases.length) return new Map();
  const rows = await db.select().from(verifiedIngredientAliases).where(inArray(verifiedIngredientAliases.normalizedAlias, aliases));
  return new Map(rows.map(row => [row.normalizedAlias, { diet: row.diet, verificationKey: row.verificationKey }]));
}
export async function lookupExactAliases(names: readonly string[], db: Database = getDb()): Promise<ReadonlyMap<string, RecipeDietId>> {
  const records = await lookupExactAliasRecords(names, db);
  return new Map([...records].map(([name, value]) => [name, value.diet]));
}

export type VerificationCostFilter = { since?: Date; until?: Date; jobId?: string; recipeId?: string; trendRunId?: string; trendOnly?: boolean };
function costFilters(filter: VerificationCostFilter): SQL[] {
  return [filter.since && gte(ingredientVerifications.createdAt, filter.since), filter.until && lt(ingredientVerifications.createdAt, filter.until),
    filter.jobId && eq(ingredientVerifications.originJobId, filter.jobId), filter.recipeId && eq(ingredientVerifications.originRecipeId, filter.recipeId),
    filter.trendRunId && eq(aiJobs.trendRunId, filter.trendRunId), filter.trendOnly === true && sql`${aiJobs.trendRunId} IS NOT NULL`,
    filter.trendOnly === false && isNull(aiJobs.trendRunId)].filter((value): value is SQL => Boolean(value));
}
const chargedCost = sql`CASE WHEN ${ingredientVerifications.costBasis}='usage' THEN ${ingredientVerifications.chargedUsd} ELSE 0 END`;
const pendingCost = sql`(${ingredientVerifications.chargedUsd} IS NULL OR ${ingredientVerifications.costBasis} IS DISTINCT FROM 'usage')`;
export async function getVerificationCosts(filter: VerificationCostFilter = {}, db: Database = getDb()) {
  const [row] = await db.select({ chargedUsd: sql<string>`coalesce(sum(${chargedCost}),0)::text`, pendingCount: sql<number>`count(*) filter(where ${pendingCost})::int`, requestCount: sql<number>`count(*)::int` })
    .from(ingredientVerifications).leftJoin(aiJobs, eq(aiJobs.id, ingredientVerifications.originJobId)).where(and(...costFilters(filter)));
  return { chargedUsd: new Decimal(row.chargedUsd).toFixed(8), pendingCount: row.pendingCount, requestCount: row.requestCount };
}
export async function getVerificationBudgetTotals(filter: { trendOnly?: boolean } = {}, db: Database = getDb()) {
  const [row] = await db.select({ daily: sql<string>`coalesce(sum(${chargedCost}) filter(where ${ingredientVerifications.createdAt}>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text`,
    monthly: sql<string>`coalesce(sum(${chargedCost}) filter(where ${ingredientVerifications.createdAt}>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text`,
    pilot: sql<string>`coalesce(sum(${chargedCost}),0)::text`, pendingCount: sql<number>`count(*) filter(where ${pendingCost})::int` })
    .from(ingredientVerifications).leftJoin(aiJobs, eq(aiJobs.id, ingredientVerifications.originJobId)).where(and(...costFilters(filter)));
  return { daily: new Decimal(row.daily).toFixed(8), monthly: new Decimal(row.monthly).toFixed(8), pilot: new Decimal(row.pilot).toFixed(8), pendingCount: row.pendingCount };
}
