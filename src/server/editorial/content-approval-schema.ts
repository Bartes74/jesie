import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { editorialRecipes } from '@/server/db/schema';

/** Text approval survives media-only revisions and never grants publication. */
export const editorialContentApprovals = pgTable('editorial_content_approval', {
  recipeId: text('recipe_id').notNull().references(() => editorialRecipes.id),
  contentHash: text('content_hash').notNull(),
  origin: text('origin').$type<'manual' | 'automated'>().notNull(),
  revision: integer('revision').notNull(),
  actorId: text('actor_id').notNull(),
  actorName: text('actor_name').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.recipeId, table.contentHash, table.origin] }),
  index('editorial_content_approval_recipe_idx').on(table.recipeId, table.approvedAt),
]);
