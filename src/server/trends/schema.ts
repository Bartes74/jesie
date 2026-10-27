import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { TrendCandidate, TrendPlatform, TrendRunStatus, TrendSearchDiagnostics } from '@/lib/trend-types';
import { editorialRecipes } from '@/server/db/schema';
export const trendSettings = pgTable('trend_setting', {
    id: text('id').primaryKey(), enabled: boolean('enabled').notNull().default(false),
    monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 16, scale: 8 }).notNull().default('150'),
    lastControlAt: timestamp('last_control_at', { withTimezone: true }), controlFingerprint: text('control_fingerprint'),
    publicationAuthorizedBy: text('publication_authorized_by'),
    reviewedPublicationEnabled: boolean('reviewed_publication_enabled').notNull().default(false),
    reviewedPublicationAuthorizedBy: text('reviewed_publication_authorized_by'),
    autoPauseReason: text('auto_pause_reason'), autoPauseToken: text('auto_pause_token'), autoPauseReviewedAt: timestamp('auto_pause_reviewed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), updatedBy: text('updated_by'),
});
export const trendRuns = pgTable('trend_run', {
    id: text('id').primaryKey(), date: text('date').notNull(), mode: text('mode').$type<'daily' | 'control'>().notNull(),
    manualRequestKey: uuid('manual_request_key'),
    generation: integer('generation').notNull().default(1), status: text('status').$type<TrendRunStatus>().notNull().default('queued'), recipeId: text('recipe_id'), expectedRevision: integer('expected_revision'), candidateId: text('candidate_id'),
    workflowId: text('workflow_id'), searchRequestId: text('search_request_id'), searchClaimedAt: timestamp('search_claimed_at', { withTimezone: true }), searchFinishedAt: timestamp('search_finished_at', { withTimezone: true }),
    searchReservedUsd: numeric('search_reserved_usd', { precision: 16, scale: 8 }).notNull().default('0'), searchChargedUsd: numeric('search_charged_usd', { precision: 16, scale: 8 }),
    packetRemainingUsd: numeric('packet_remaining_usd', { precision: 16, scale: 8 }).notNull().default('0'),
    searchModel: text('search_model'), searchDiagnostics: jsonb('search_diagnostics').$type<TrendSearchDiagnostics>(), configurationFingerprint: text('configuration_fingerprint'),
    sources: jsonb('sources').$type<Record<TrendPlatform, {
        status: 'available' | 'no_evidence' | 'unavailable';
        count: number;
    }>>().notNull(),
    error: text('error'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('trend_run_date_unique').on(table.date).where(sql`${table.manualRequestKey} IS NULL`), uniqueIndex('trend_run_manual_request_unique').on(table.manualRequestKey), index('trend_run_recipe_idx').on(table.recipeId)]);
export const trendCandidates = pgTable('trend_candidate', {
    id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => trendRuns.id), dishKey: text('dish_key').notNull(),
    data: jsonb('data').$type<TrendCandidate>().notNull(), selected: boolean('selected').notNull().default(false),
}, table => [index('trend_candidate_run_idx').on(table.runId)]);
/** One publication delivery for each Warsaw calendar date, independently of search dates. */
export const trendPublicationDays = pgTable('trend_publication_day', {
    date: text('date').primaryKey(), dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status').$type<'pending' | 'published' | 'expired'>().notNull().default('pending'),
    generation: integer('generation').notNull().default(1), workflowId: text('workflow_id'),
    recipeId: text('recipe_id'), runId: text('run_id'), publicationId: text('publication_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type PublicationPlanAuditState = { recipeId: string; expectedContentHash: string; plannedBy: string };
/** A reservation is independent of approval and of the immutable publication result. */
export const editorialPublicationPlans = pgTable('editorial_publication_plan', {
    date: text('date').primaryKey().references(() => trendPublicationDays.date),
    recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
    expectedContentHash: text('expected_content_hash').notNull(),
    plannedBy: text('planned_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('editorial_publication_plan_recipe_unique').on(table.recipeId)]);
export const editorialPublicationPlanAudit = pgTable('editorial_publication_plan_audit', {
    id: uuid('id').primaryKey(), date: text('date').notNull(),
    action: text('action').$type<'save' | 'remove'>().notNull(),
    actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
    before: jsonb('before_state').$type<PublicationPlanAuditState | null>(),
    after: jsonb('after_state').$type<PublicationPlanAuditState | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('editorial_publication_plan_audit_date_idx').on(table.date, table.createdAt)]);
export const trendSettingAudit = pgTable('trend_setting_audit', {
    id: uuid('id').primaryKey(), actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
    before: jsonb('before_state').$type<{ enabled: boolean; monthlyLimitUsd: string; publicationAuthorizedBy: string | null; reviewedPublicationEnabled?: boolean; reviewedPublicationAuthorizedBy?: string | null }>().notNull(),
    after: jsonb('after_state').$type<{ enabled: boolean; monthlyLimitUsd: string; publicationAuthorizedBy: string | null; reviewedPublicationEnabled?: boolean; reviewedPublicationAuthorizedBy?: string | null }>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const trendSchema = { trendSettings, trendRuns, trendCandidates, trendPublicationDays, trendSettingAudit, editorialPublicationPlans, editorialPublicationPlanAudit };
