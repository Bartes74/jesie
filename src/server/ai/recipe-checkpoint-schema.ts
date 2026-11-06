import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Response } from 'openai/resources/responses/responses';
import type { RecipeDietId } from '@/lib/recipe-diet';
import { aiJobs } from './schema';

export type ReviewedRecipeIngredient = { ingredientId: string; name: { pl: string; en: string }; diet: RecipeDietId };

export const recipeResponses = pgTable('ai_recipe_response', {
  jobId: text('job_id').primaryKey().references(() => aiJobs.id),
  requestId: text('request_id').notNull(), response: jsonb('response').$type<Response>().notNull(),
  digest: text('digest').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_recipe_response_request_unique').on(table.requestId)]);

export const recipeManualRepairs = pgTable('ai_recipe_manual_repair', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull().references(() => aiJobs.id),
  recipeId: text('recipe_id').notNull(), version: integer('version').notNull(),
  proposal: jsonb('proposal').$type<Record<string, unknown>>().notNull(),
  reviewedIngredients: jsonb('reviewed_ingredients').$type<ReviewedRecipeIngredient[]>().notNull(),
  reason: text('reason').notNull(), actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('ai_recipe_manual_repair_version_unique').on(table.jobId, table.version), index('ai_recipe_manual_repair_recipe_idx').on(table.recipeId)]);
