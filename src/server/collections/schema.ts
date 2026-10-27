import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { CollectionContent, CollectionDefinition, CollectionRecord } from '@/lib/collections';

export const collections = pgTable('event_collection', {
  id: text('id').primaryKey(), revision: integer('revision').notNull().default(1),
  content: jsonb('content').$type<CollectionContent>().notNull(), contentHash: text('content_hash').notNull(),
  publicationStatus: text('publication_status').$type<CollectionRecord['publicationStatus']>().notNull().default('never_published'),
  publishedId: text('published_id'), publishedRevision: integer('published_revision'), firstPublishedAt: timestamp('first_published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), createdBy: text('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), updatedBy: text('updated_by').notNull(), updatedByName: text('updated_by_name').notNull(),
}, table => [
  check('event_collection_revision_positive', sql`${table.revision}>0`),
  check('event_collection_publication_status_valid', sql`${table.publicationStatus} IN ('never_published','published','unpublished')`),
  index('event_collection_updated_idx').on(table.updatedAt),
  uniqueIndex('event_collection_slug_pl_unique').on(sql`(${table.content}->'slug'->>'pl')`).where(sql`coalesce(${table.content}->'slug'->>'pl','')<>''`),
  uniqueIndex('event_collection_slug_en_unique').on(sql`(${table.content}->'slug'->>'en')`).where(sql`coalesce(${table.content}->'slug'->>'en','')<>''`),
]);
export const collectionPublications = pgTable('event_collection_publication', {
  id: text('id').primaryKey(), collectionId: text('collection_id').notNull().references(() => collections.id), revision: integer('revision').notNull(),
  snapshot: jsonb('snapshot').$type<CollectionDefinition>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(), publishedBy: text('published_by').notNull(), publishedByName: text('published_by_name').notNull(),
}, table => [uniqueIndex('event_collection_publication_revision_unique').on(table.collectionId, table.revision), uniqueIndex('event_collection_publication_identity_unique').on(table.id, table.collectionId)]);
export const collectionSchema = { collections, collectionPublications };
