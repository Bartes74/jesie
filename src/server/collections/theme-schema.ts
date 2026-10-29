import { integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { collections } from './schema';
import type { CollectionAccentSlot, CollectionTheme } from '@/lib/collections';
import type { ThemeGenerationPart, ThemeGenerationStatus } from '@/lib/collection-theme-types';
import type { ThemeProposal } from './theme-policy';
import type { Localised } from '@/lib/recipes';

export type ThemeImageKind = 'hero' | 'atmosphere' | CollectionAccentSlot;
export type ThemeJobKind = 'spec' | ThemeImageKind;

export const collectionThemeGenerations = pgTable('collection_theme_generation', {
  id: text('id').primaryKey(), collectionId: text('collection_id').notNull().references(() => collections.id),
  baseRevision: integer('base_revision').notNull(), part: text('part').$type<ThemeGenerationPart>().notNull(),
  brief: text('brief').notNull(), inspirationAssetId: text('inspiration_asset_id'),
  baseTheme: jsonb('base_theme').$type<CollectionTheme>(), proposal: jsonb('proposal').$type<ThemeProposal>(),
  input: jsonb('input').$type<{ title: Localised; description: Localised; imageModel?: string }>().notNull(),
  theme: jsonb('theme').$type<CollectionTheme>(), status: text('status').$type<ThemeGenerationStatus>().notNull().default('queued'),
  requestKey: text('request_key').notNull(), inputHash: text('input_hash').notNull(),
  createdBy: text('created_by').notNull(), error: text('error'), appliedRevision: integer('applied_revision'),
  dispatchToken: text('dispatch_token'), dispatchExpiresAt: timestamp('dispatch_expires_at', { withTimezone: true }),
  workflowId: text('workflow_id'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('collection_theme_request_unique').on(table.createdBy, table.requestKey), index('collection_theme_collection_idx').on(table.collectionId)]);

export const collectionThemeJobs = pgTable('collection_theme_job', {
  id: text('id').primaryKey(), generationId: text('generation_id').notNull().references(() => collectionThemeGenerations.id),
  kind: text('kind').$type<ThemeJobKind>().notNull(), model: text('model').notNull(),
  status: text('status').$type<'queued' | 'submitting' | 'generating' | 'ready' | 'failed' | 'uncertain'>().notNull().default('queued'),
  providerRequestId: text('provider_request_id'), providerFinishedAt: timestamp('provider_finished_at', { withTimezone: true }),
  chargedUsd: numeric('charged_usd', { precision: 16, scale: 8 }),
  result: jsonb('result').$type<ThemeProposal | { assetId: string }>(),
  error: text('error'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('collection_theme_stage_unique').on(table.generationId, table.kind)]);

export const collectionAssets = pgTable('collection_asset', {
  id: text('id').primaryKey(), collectionId: text('collection_id').notNull().references(() => collections.id),
  generationId: text('generation_id').references(() => collectionThemeGenerations.id),
  kind: text('kind').$type<'inspiration' | ThemeImageKind>().notNull(),
  blobPathname: text('blob_pathname').notNull(), sha256: text('sha256').notNull(),
  width: integer('width').notNull(), height: integer('height').notNull(), contentType: text('content_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('collection_asset_path_unique').on(table.blobPathname)]);

export const collectionThemeCosts = pgTable('collection_theme_cost', {
  jobId: text('job_id').primaryKey().references(() => collectionThemeJobs.id),
  amountUsd: numeric('amount_usd', { precision: 16, scale: 8 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const collectionThemeSchema = { collectionThemeGenerations, collectionThemeJobs, collectionAssets, collectionThemeCosts };
