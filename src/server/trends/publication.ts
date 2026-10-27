import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { EditorialActor } from '@/lib/editorial-types';
import type { TrendAutomation, TrendPublicationDay, TrendPublicationResult, TrendPublicationState } from '@/lib/trend-types';
import { publicationTime, warsawPublicationDate } from '@/lib/daily-publication';
import { getDb } from '@/server/db';
import { nextTrendSearchAt } from '@/lib/trend-search-budget';
import { user } from '@/server/db/auth-schema';
import { EditorialError } from '@/server/editorial/store';
import { trendPublicationDays } from './schema';
import { TrendError } from './store';

type Database = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Day = typeof trendPublicationDays.$inferSelect;
const graceMs = 60 * 60 * 1000;
async function lock(tx: Tx) { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`); }
async function wallTime(db: Database | Tx) {
  const result = await db.execute(sql`SELECT clock_timestamp() AS now`);
  return new Date((result.rows[0] as { now: string | Date }).now);
}
function dueFor(date: string) {
  try { return publicationTime(date); }
  catch { throw new TrendError(422, 'INVALID_PUBLICATION_DATE', 'Podaj prawidłowy dzień publikacji.'); }
}
function dto(row: Day): TrendPublicationDay {
  return { date: row.date, dueAt: row.dueAt.toISOString(), status: row.status, generation: row.generation, workflowId: row.workflowId };
}
function timeStatus(date: string, dueAt: Date, now: Date) {
  if (now.getTime() < dueAt.getTime()) return 'early' as const;
  if (warsawPublicationDate(now) !== date || now.getTime() >= dueAt.getTime() + graceMs) return 'expired' as const;
  return 'due' as const;
}

/** Legacy publication APIs remain readable, but only a human may publish. */
export async function publicationAutomationGate(_db: Database | Tx = getDb()) {
  void _db; // Kept for callers of the retired publication API.
  return { enabled: false, canEnable: false, authorizedOwnerId: null,
    reason: 'Publikacja odbywa się ręcznie w edytorze po Twoim sprawdzeniu przepisu i fotografii.' };
}

export async function ensurePublicationDay(date: string): Promise<TrendPublicationDay> {
  const dueAt = dueFor(date);
  return getDb().transaction(async tx => {
    await lock(tx);
    const now = await wallTime(tx);
    // Future timers may be prepared early. Old deliveries are recorded as expired, never backfilled.
    const [row] = await tx.insert(trendPublicationDays).values({ date, dueAt,
      status: timeStatus(date, dueAt, now) === 'expired' ? 'expired' : 'pending', createdAt: now, updatedAt: now })
      .onConflictDoNothing().returning();
    if (row) return dto(row);
    const [existing] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date));
    return dto(existing);
  });
}

/** Concurrent/duplicate dispatches may start, but only one durable worker owns the timer. */
export async function attachPublicationWorkflow(date: string, workflowId: string, generation: number): Promise<boolean> {
  dueFor(date);
  if (!workflowId || workflowId.length > 200) throw new TrendError(422, 'INVALID_WORKFLOW', 'Brak identyfikatora harmonogramu.');
  return getDb().transaction(async tx => {
    await lock(tx);
    const [row] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date)).for('update');
    if (!row || row.generation !== generation || row.status !== 'pending') return false;
    if (row.workflowId) return row.workflowId === workflowId;
    await tx.update(trendPublicationDays).set({ workflowId, updatedAt: await wallTime(tx) }).where(eq(trendPublicationDays.date, date));
    return true;
  });
}

/** Caller confirms the linked Workflow has terminated; this resets only a pending, nonpaid timer lease. */
export async function resetPublicationWorkflow(date: string, expectedWorkflowId: string, expectedGeneration: number): Promise<TrendPublicationDay | null> {
  dueFor(date);
  return getDb().transaction(async tx => {
    await lock(tx);
    const now = await wallTime(tx);
    const [row] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date)).for('update');
    if (!row || row.status !== 'pending' || row.workflowId !== expectedWorkflowId || row.generation !== expectedGeneration
      || timeStatus(date, row.dueAt, now) === 'expired') return null;
    const [updated] = await tx.update(trendPublicationDays).set({ workflowId: null, generation: row.generation + 1, updatedAt: now })
      .where(eq(trendPublicationDays.date, date)).returning();
    return dto(updated);
  });
}

async function state(_tx: Database | Tx, row: Day, now: Date): Promise<TrendPublicationState> {
  return { ...dto(row), serverNow: now.toISOString(), canPublish: false,
    reason: (await publicationAutomationGate()).reason };
}

export async function publicationState(date: string): Promise<TrendPublicationState> {
  dueFor(date);
  return getDb().transaction(async tx => {
    await lock(tx);
    const now = await wallTime(tx);
    const [row] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date));
    if (!row) throw new TrendError(404, 'PUBLICATION_DAY_NOT_FOUND', 'Nie przygotowano harmonogramu tego dnia.');
    return state(tx, row, now);
  });
}

/** A queued legacy timer may read its old outcome; it cannot release a recipe. */
export async function publishDueRecipeInTransaction(tx: Tx, date: string, serverNow: Date, generation?: number, _freshClock?: () => Promise<Date>): Promise<TrendPublicationResult> {
  void _freshClock;
  await lock(tx); const dueAt = dueFor(date);
  const [row] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date)).for('update');
  if (!row) throw new TrendError(404, 'PUBLICATION_DAY_NOT_FOUND', 'Nie przygotowano harmonogramu tego dnia.');
  if (generation !== undefined && row.generation !== generation) throw new TrendError(409, 'PUBLICATION_SUPERSEDED', 'Harmonogram zastąpiło nowe uruchomienie.');
  if (row.dueAt.getTime() !== dueAt.getTime()) throw new TrendError(409, 'PUBLICATION_TIME_CHANGED', 'Harmonogram ma nieprawidłowy czas publikacji.');
  if (row.status === 'published') return { status: 'published', state: await state(tx, row, serverNow), recipeId: row.recipeId!, publicationId: row.publicationId! };
  if (row.status === 'expired') return { status: 'expired', state: await state(tx, row, serverNow) };
  return { status: 'disabled', state: await state(tx, row, serverNow) };
}

export async function publishDueRecipe(date: string, generation?: number): Promise<TrendPublicationResult> {
  return getDb().transaction(async tx => { await lock(tx); return publishDueRecipeInTransaction(tx, date, await wallTime(tx), generation, () => wallTime(tx)); });
}

export async function getTrendAutomation(db: Database | Tx = getDb(), _actor?: EditorialActor): Promise<TrendAutomation> {
  void _actor;
  const now = await wallTime(db); const gate = await publicationAutomationGate(db);
  return { enabled: false, timezone: 'Europe/Warsaw', serverNow: now.toISOString(), nextSearchAt: nextTrendSearchAt(now),
    readyCount: 0, publishedToday: null, reason: gate.reason, canEnable: false };
}

/** Compatibility response for the retired scheduled-publication control. */
export type ReviewedSchedule = {
  enabled: boolean; readyCount: number; targetCount: number; nextPublicationAt: string | null; reason: string | null;
  readyRecipes: Array<{ id: string; title: string }>;
};
export async function getReviewedSchedule(_db: Database | Tx = getDb()): Promise<ReviewedSchedule> {
  void _db;
  return { enabled: false, readyCount: 0, targetCount: 0, nextPublicationAt: null,
    reason: (await publicationAutomationGate()).reason, readyRecipes: [] };
}
export async function updateReviewedSchedule(_enabled: boolean, actor: EditorialActor): Promise<ReviewedSchedule> {
  return getDb().transaction(async tx => {
    await lock(tx);
    const [owner] = await tx.select().from(user).where(eq(user.id, actor.id)).for('share');
    if (!owner || owner.disabled || owner.role !== 'owner') throw new EditorialError(403, 'OWNER_REQUIRED', 'Tylko aktywny właściciel może zmienić ustawienia redakcji.');
    throw new EditorialError(410, 'MANUAL_PUBLICATION_REQUIRED', 'Publikowanie według harmonogramu zostało wyłączone. Publikuj ręcznie w edytorze.');
  });
}
