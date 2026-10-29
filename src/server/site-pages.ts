import 'server-only';
import { eq } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { aboutPageContentSchema, type AboutPageContent, type AboutPageRecord } from '@/lib/about-page';
import type { EditorialActor } from '@/lib/editorial-types';
import { getDb } from '@/server/db';
import { user } from '@/server/db/auth-schema';
import { adminFailure, adminResponse } from '@/server/http/admin';

export const sitePages = pgTable('site_page', {
  id: text('id').primaryKey(), revision: integer('revision').notNull().default(1),
  content: jsonb('content').$type<AboutPageContent>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), updatedBy: text('updated_by').notNull(), updatedByName: text('updated_by_name').notNull(),
});
/** Revision 0 means "the built-in text, never saved". */
export const saveAboutPageInput = z.object({ expectedRevision: z.number().int().nonnegative(), content: z.unknown() }).strict();

export class SitePageError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly latest?: AboutPageRecord | null) { super(message); this.name = 'SitePageError'; }
}
export function sitePageFailure(error: unknown) {
  if (error instanceof SitePageError) return adminResponse({ code: error.code, error: error.message, latest: error.latest }, error.status);
  return adminFailure(error);
}

const dto = (row: typeof sitePages.$inferSelect): AboutPageRecord => ({ revision: row.revision, content: aboutPageContentSchema.parse(row.content), updatedAt: row.updatedAt.toISOString(), updatedByName: row.updatedByName });

export async function getAboutPage(): Promise<AboutPageRecord | null> {
  const [row] = await getDb().select().from(sitePages).where(eq(sitePages.id, 'about')).limit(1);
  return row ? dto(row) : null;
}

export async function saveAboutPage(input: z.infer<typeof saveAboutPageInput>, actor: EditorialActor): Promise<AboutPageRecord> {
  const content = aboutPageContentSchema.parse(input.content);
  return getDb().transaction(async tx => {
    const [account] = await tx.select({ id: user.id, name: user.name, role: user.role, disabled: user.disabled }).from(user).where(eq(user.id, actor.id)).for('share').limit(1);
    if (!account || account.disabled || (account.role !== 'owner' && account.role !== 'admin')) throw new SitePageError(403, 'FORBIDDEN', 'Brak dostępu do edycji strony.');
    const [current] = await tx.select().from(sitePages).where(eq(sitePages.id, 'about')).for('update').limit(1);
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new SitePageError(409, 'REVISION_CONFLICT', 'Strona zmieniła się w międzyczasie. Wczytaj bieżącą wersję.', current ? dto(current) : null);
    const values = { content, updatedAt: new Date(), updatedBy: account.id, updatedByName: account.name };
    // The first save races on the primary key; a concurrent insert surfaces as a conflict, not an overwrite.
    const [row] = current
      ? await tx.update(sitePages).set({ ...values, revision: current.revision + 1 }).where(eq(sitePages.id, 'about')).returning()
      : await tx.insert(sitePages).values({ id: 'about', ...values }).onConflictDoNothing().returning();
    if (!row) throw new SitePageError(409, 'REVISION_CONFLICT', 'Strona zmieniła się w międzyczasie. Wczytaj bieżącą wersję.');
    return dto(row);
  });
}
