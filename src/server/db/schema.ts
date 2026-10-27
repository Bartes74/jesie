import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { EditorialContent, EditorialStatus, PublicationStatus, ReviewChecks } from '../../lib/editorial-types';

export const editorialRecipes = pgTable('editorial_recipe', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull().default(1),
  content: jsonb('content').$type<EditorialContent>().notNull(),
  contentHash: text('content_hash').notNull(),
  editorialStatus: text('editorial_status').$type<EditorialStatus>().notNull().default('draft'),
  publicationStatus: text('publication_status').$type<PublicationStatus>().notNull().default('never_published'),
  checks: jsonb('checks').$type<ReviewChecks>().notNull(),
  checksRevision: integer('checks_revision').notNull().default(1),
  approvedRevision: integer('approved_revision'),
  publishedId: text('published_id'),
  publishedRevision: integer('published_revision'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
  updatedByName: text('updated_by_name').notNull(),
}, (table) => [
  check('editorial_revision_positive', sql`${table.revision} > 0`),
  check('editorial_status_valid', sql`${table.editorialStatus} in ('draft', 'in_review', 'approved', 'archived')`),
  check('publication_status_valid', sql`${table.publicationStatus} in ('never_published', 'published', 'unpublished')`),
  check('editorial_deleted_not_publishable', sql`${table.deletedAt} IS NULL OR (${table.publicationStatus} <> 'published' AND ${table.approvedRevision} IS NULL)`),
  index('editorial_recipe_updated_idx').on(table.updatedAt),
  index('editorial_recipe_publication_idx').on(table.publicationStatus),
  index('editorial_recipe_deleted_idx').on(table.deletedAt),
]);

export const editorialVersions = pgTable('editorial_version', {
  recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  revision: integer('revision').notNull(),
  content: jsonb('content').$type<EditorialContent>().notNull(),
  contentHash: text('content_hash').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  createdByName: text('created_by_name').notNull(),
}, (table) => [primaryKey({ columns: [table.recipeId, table.revision] })]);

export const editorialPublications = pgTable('editorial_publication', {
  id: text('id').primaryKey(),
  recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  revision: integer('revision').notNull(),
  snapshot: jsonb('snapshot').$type<EditorialContent>().notNull(),
  contentHash: text('content_hash').notNull(),
  checks: jsonb('checks').$type<ReviewChecks>().notNull(),
  approvalOrigin: text('approval_origin').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  publishedBy: text('published_by').notNull(),
  publishedByName: text('published_by_name').notNull(),
  reviewedBy: text('reviewed_by'),
  reviewedByName: text('reviewed_by_name'),
  reviewedRevision: integer('reviewed_revision'),
}, (table) => [
  uniqueIndex('editorial_publication_recipe_revision_unique').on(table.recipeId, table.revision),
]);

// A historical address remains owned by its recipe, even after withdrawal.
export const editorialSlugs = pgTable('editorial_slug', {
  locale: text('locale').notNull(),
  slug: text('slug').notNull(),
  recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.locale, table.slug] })]);

export const editorialAudit = pgTable('editorial_audit', {
  id: text('id').primaryKey(),
  recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  revision: integer('revision').notNull(),
  action: text('action').notNull(),
  actorId: text('actor_id').notNull(),
  actorName: text('actor_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const editorialOutbox = pgTable('editorial_outbox', {
  id: text('id').primaryKey(),
  recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  revision: integer('revision').notNull(),
  event: text('event').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  cacheProcessedAt: timestamp('cache_processed_at', { withTimezone: true }),
  status: text('status').$type<'pending' | 'processing' | 'retry' | 'completed' | 'disabled'>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastError: text('last_error'),
  indexNowStatus: integer('indexnow_status'),
  discoveryWorkflowId: text('discovery_workflow_id'),
  discoveryGeneration: integer('discovery_generation').notNull().default(1),
  discoveryDispatchToken: text('discovery_dispatch_token'),
  discoveryDispatchExpiresAt: timestamp('discovery_dispatch_expires_at', { withTimezone: true }),
});

export const editorialSchema = { editorialRecipes, editorialVersions, editorialPublications, editorialSlugs, editorialAudit, editorialOutbox };
