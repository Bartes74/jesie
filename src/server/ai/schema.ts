import { boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AiKind, AiProvider, AiResult, AiStatus } from '../../lib/ai-types';
import type { EditorialContent } from '../../lib/editorial-types';
import type { Localised } from '../../lib/recipes';
import type { MediaTile } from '../../lib/recipe-media';
import type { AiPhotoBatchStatus, AiPhotoKind } from '../../lib/ai-photo-batch-types';
import type { AiBudgetState, UpdateAiBudgetSettings } from '../../lib/ai-budget-types';
import { editorialRecipes } from '../db/schema';

export const aiJobs = pgTable('ai_job', {
  id: text('id').primaryKey(), trendRunId: text('trend_run_id'), photoBatchId: text('photo_batch_id'), recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  baseRevision: integer('base_revision').notNull(), kind: text('kind').$type<AiKind>().notNull(), targetId: text('target_id'),
  status: text('status').$type<AiStatus>().notNull().default('queued'), provider: text('provider').$type<AiProvider>().notNull(), model: text('model').notNull(),
  brief: text('brief').notNull(), requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  ingredientKey: text('ingredient_key'), reuseSourceJobId: text('reuse_source_job_id'), ingredientResolvedAt: timestamp('ingredient_resolved_at', { withTimezone: true }),
  manualContentApprovalHash: text('manual_content_approval_hash'),
  input: jsonb('input').$type<EditorialContent>().notNull(), createdBy: text('created_by').notNull(), createdByName: text('created_by_name').notNull(),
  providerRequestId: text('provider_request_id'), reservedUsd: numeric('reserved_usd', { precision: 16, scale: 8 }).notNull().default('0'),
  providerFinishedAt: timestamp('provider_finished_at', { withTimezone: true }),
  chargedUsd: numeric('charged_usd', { precision: 16, scale: 8 }), costBasis: text('cost_basis').$type<'usage' | 'reservation'>(),
  usage: jsonb('usage').$type<{ inputTokens: number; outputTokens: number }>(), result: jsonb('result').$type<AiResult>(),
  errorCode: text('error_code'), errorMessage: text('error_message'), appliedRevision: integer('applied_revision'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_job_actor_request_unique').on(table.createdBy, table.requestKey), index('ai_job_recipe_created_idx').on(table.recipeId, table.createdAt)]);

export const aiAssets = pgTable('ai_asset', {
  id: text('id').primaryKey(), recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id), jobId: text('job_id').notNull().references(() => aiJobs.id),
  kind: text('kind').$type<Exclude<AiKind, 'recipe'>>().notNull(), targetId: text('target_id'),
  blobPathname: text('blob_pathname').notNull(), width: integer('width').notNull(), height: integer('height').notNull(), contentType: text('content_type').notNull(),
  originalBlobPathname: text('original_blob_pathname'),
  alt: jsonb('alt').$type<Localised>().notNull(), caption: jsonb('caption').$type<Localised>().notNull(), model: text('model').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_asset_job_unique').on(table.jobId), uniqueIndex('ai_asset_blob_unique').on(table.blobPathname), index('ai_asset_recipe_idx').on(table.recipeId)]);

export const aiLedger = pgTable('ai_cost_ledger', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull().references(() => aiJobs.id),
  entry: text('entry').$type<'reserve' | 'settle' | 'reconcile'>().notNull(), amountUsd: numeric('amount_usd', { precision: 16, scale: 8 }).notNull(),
  basis: text('basis').$type<'reservation' | 'usage' | 'cancelled' | 'not_charged'>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_ledger_job_entry_unique').on(table.jobId, table.entry)]);

export const aiRecipeRecoveries = pgTable('ai_recipe_recovery', {
  jobId: text('job_id').primaryKey().references(() => aiJobs.id), rootJobId: text('root_job_id').notNull().references(() => aiJobs.id),
  parentJobId: text('parent_job_id').references(() => aiJobs.id), attempt: integer('attempt').notNull(),
  trendGeneration: integer('trend_generation'),
  repairIssues: jsonb('repair_issues').$type<{ field: string; message: string }[]>().notNull().default([]),
  failureIssues: jsonb('failure_issues').$type<{ field: string; message: string }[]>().notNull().default([]),
  repairable: boolean('repairable').notNull().default(false), generation: integer('generation').notNull().default(1),
  blockedCode: text('blocked_code'), blockedMessage: text('blocked_message'),
  workflowRunId: text('workflow_run_id'), dispatchClaimedAt: timestamp('dispatch_claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_recipe_recovery_parent_unique').on(table.parentJobId), uniqueIndex('ai_recipe_recovery_root_attempt_unique').on(table.rootJobId, table.attempt)]);

export const ingredientImages = pgTable('ingredient_image_catalog', {
  key: text('key').notNull(), product: text('product').notNull(), form: text('form').notNull(), styleProfile: text('style_profile').notNull(),
  assetId: text('asset_id').notNull().references(() => aiAssets.id), sourceJobId: text('source_job_id').notNull().references(() => aiJobs.id),
  photo: jsonb('photo').$type<MediaTile>().notNull(), eligibility: text('eligibility').$type<'usable'|'approved'|'rejected'>().notNull().default('usable'),
  createdAt: timestamp('created_at', { withTimezone:true }).notNull().defaultNow(),
}, table=>[primaryKey({columns:[table.key,table.assetId]}),index('ingredient_image_key_idx').on(table.key)]);
export type StoredPhotoBatchSlot = { kind: AiPhotoKind; targetId: string | null; label: string; jobId: string | null; recoverySourceJobId?: string; replacePhoto?: MediaTile | null };
export const aiPhotoBatches = pgTable('ai_photo_batch', {
  id: text('id').primaryKey(), recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  baseRevision: integer('base_revision').notNull(), sourceJobId: text('source_job_id').references(() => aiJobs.id),
  input: jsonb('input').$type<EditorialContent>().notNull(), inputHash: text('input_hash').notNull(),
  slots: jsonb('slots').$type<StoredPhotoBatchSlot[]>().notNull(),
  status: text('status').$type<AiPhotoBatchStatus>().notNull().default('queued'),
  requestKey: text('request_key').notNull(), createdBy: text('created_by').notNull(), createdByName: text('created_by_name').notNull(),
  reservedUsd: numeric('reserved_usd', { precision: 16, scale: 8 }).notNull().default('0'), remainingReservedUsd: numeric('remaining_reserved_usd', { precision: 16, scale: 8 }).notNull().default('0'),
  generation: integer('generation').notNull().default(1), workflowRunId: text('workflow_run_id'),
  errorCode: text('error_code'), errorMessage: text('error_message'), appliedRevision: integer('applied_revision'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_photo_batch_actor_request_unique').on(table.createdBy, table.requestKey), index('ai_photo_batch_recipe_created_idx').on(table.recipeId, table.createdAt)]);
export const aiBudgetSettings = pgTable('ai_budget_settings', {
  id: text('id').primaryKey(), revision: integer('revision').notNull().default(0),
  dailyLimitUsd: numeric('daily_limit_usd', { precision: 16, scale: 8 }),
  monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 16, scale: 8 }),
  pilotLimitUsd: numeric('pilot_limit_usd', { precision: 16, scale: 8 }),
  bypassStartedAt: timestamp('bypass_started_at', { withTimezone: true }), bypassUntil: timestamp('bypass_until', { withTimezone: true }),
  updatedBy: text('updated_by'), updatedByName: text('updated_by_name'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const aiBudgetAudit = pgTable('ai_budget_settings_audit', {
  id: text('id').primaryKey(), revision: integer('revision').notNull(),
  action: text('action').$type<UpdateAiBudgetSettings['action']>().notNull(), actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
  before: jsonb('before_state').$type<AiBudgetState>().notNull(), after: jsonb('after_state').$type<AiBudgetState>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_budget_audit_revision_unique').on(table.revision)]);
export const aiSchema = { aiJobs, aiAssets, aiLedger, aiRecipeRecoveries, ingredientImages, aiPhotoBatches, aiBudgetSettings, aiBudgetAudit };
