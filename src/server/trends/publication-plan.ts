import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { EditorialActor } from '@/lib/editorial-types';
import { reviewKeys } from '@/lib/editorial-types';
import { publicationTime } from '@/lib/daily-publication';
import { getDb } from '@/server/db';
import { user } from '@/server/db/auth-schema';
import { editorialAudit, editorialRecipes } from '@/server/db/schema';
import { aiJobs } from '@/server/ai/schema';
import { contentHash, EditorialError, verifiedPublicationIssues } from '@/server/editorial/store';
import { editorialPublicationPlans, trendPublicationDays } from './schema';

type Database = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Plan = typeof editorialPublicationPlans.$inferSelect;
type Recipe = typeof editorialRecipes.$inferSelect;
export type PublicationPlanInput = { date: string; recipeId: string; expectedRevision: number };
export type PublicationPlanEntry = {
  date: string; dueAt: string; recipeId: string; title: string; revision: number;
  expectedContentHash: string; currentContentMatches: boolean; updatedAt: string;
  status: 'ready' | 'needs_approval' | 'missing_photos' | 'pending_jobs' | 'needs_refresh' | 'already_published' | 'expired' | 'unavailable' | 'incomplete';
  ready: boolean; missingPhotos: number; pendingJobs: boolean; issues: string[];
};

export async function lockPublicationPlan(tx: Tx) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
}
async function wallTime(db: Database | Tx) {
  const result = await db.execute(sql`SELECT clock_timestamp() AS now`);
  return new Date((result.rows[0] as { now: string | Date }).now);
}
function dueFor(date: string) {
  try { return publicationTime(date); }
  catch { throw new EditorialError(422, 'INVALID_PUBLICATION_DATE', 'Podaj prawidłowy dzień publikacji.'); }
}
async function ownerAccount(tx: Tx, actor: EditorialActor) {
  const [owner] = await tx.select().from(user).where(eq(user.id, actor.id)).for('share');
  if (!owner || owner.disabled || owner.role !== 'owner')
    throw new EditorialError(403, 'OWNER_REQUIRED', 'Tylko aktywny właściciel może zmienić plan publikacji.');
  return owner;
}

async function entry(plan: Plan, recipe: Recipe, dayStatus: 'pending' | 'published' | 'expired', db: Database | Tx, now: Date): Promise<PublicationPlanEntry> {
  const dueAt = dueFor(plan.date);
  const currentContentMatches = recipe.contentHash === plan.expectedContentHash && contentHash(recipe.content) === plan.expectedContentHash;
  const content = recipe.content;
  const missingPhotos = Number(!content.recipe.image)
    + content.recipe.ingredients.filter(item => !content.photos.ingredients[item.id]).length
    + content.recipe.steps.filter(item => isStepPhotoRequired(content, item.id) && !content.photos.steps[item.id]).length;
  const validation = await verifiedPublicationIssues(content, db);
  const [pending] = await db.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, recipe.id),
    sql`(${aiJobs.status} in ('queued','submitting','generating','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
  const [approval] = await db.select({ id: editorialAudit.id }).from(editorialAudit).innerJoin(user, eq(user.id, editorialAudit.actorId))
    .where(and(eq(editorialAudit.recipeId, recipe.id), eq(editorialAudit.revision, recipe.revision), eq(editorialAudit.action, 'approve'),
      eq(user.disabled, false), sql`${user.role} in ('owner','admin')`)).limit(1);
  const approved = Boolean(approval && recipe.editorialStatus === 'approved' && recipe.approvedRevision === recipe.revision
    && recipe.checksRevision === recipe.revision && reviewKeys.every(key => recipe.checks[key]));
  const issues: string[] = [];
  if (!currentContentMatches) issues.push('Treść zmieniła się od zapisania planu. Właściciel musi odświeżyć rezerwację tej wersji.');
  if (!approved) issues.push('Bieżąca wersja wymaga sześciu ręcznych akceptacji i zatwierdzenia w edytorze.');
  if (missingPhotos) issues.push(`Brakuje ${missingPhotos} zdjęć wymaganych do publikacji.`);
  if (pending) issues.push('Przepis ma niezakończone zlecenie.');
  issues.push(...validation.map(issue => issue.message));
  let status: PublicationPlanEntry['status'];
  if (recipe.publishedId || recipe.publicationStatus !== 'never_published') status = 'already_published';
  else if (recipe.deletedAt || recipe.editorialStatus === 'archived') status = 'unavailable';
  else if (dayStatus === 'expired' || now.getTime() >= dueAt.getTime() + 3_600_000) status = 'expired';
  else if (!currentContentMatches) status = 'needs_refresh';
  else if (missingPhotos || validation.some(issue => issue.field === 'image' || issue.field.endsWith('.photo'))) status = 'missing_photos';
  else if (pending) status = 'pending_jobs';
  else if (validation.length) status = 'incomplete';
  else if (!approved) status = 'needs_approval';
  else status = 'ready';
  if (status === 'already_published') issues.unshift('Przepis został już opublikowany i nie zostanie opublikowany ponownie.');
  if (status === 'unavailable') issues.unshift('Przepis jest w archiwum albo w koszu.');
  if (status === 'expired') issues.unshift('Termin minął. Właściciel może wybrać nowy przyszły dzień lub anulować rezerwację.');
  return { date: plan.date, dueAt: dueAt.toISOString(), recipeId: recipe.id, title: content.recipe.title.pl,
    revision: recipe.revision, expectedContentHash: plan.expectedContentHash, currentContentMatches, updatedAt: plan.updatedAt.toISOString(),
    status, ready: status === 'ready', missingPhotos, pendingJobs: Boolean(pending), issues: [...new Set(issues)] };
}

export async function getPublicationPlan(db: Database | Tx = getDb()): Promise<PublicationPlanEntry[]> {
  const now = await wallTime(db);
  const rows = await db.select({ plan: editorialPublicationPlans, recipe: editorialRecipes, dayStatus: trendPublicationDays.status }).from(editorialPublicationPlans)
    .innerJoin(editorialRecipes, eq(editorialRecipes.id, editorialPublicationPlans.recipeId))
    .innerJoin(trendPublicationDays, eq(trendPublicationDays.date, editorialPublicationPlans.date)).orderBy(asc(editorialPublicationPlans.date));
  const entries: PublicationPlanEntry[] = [];
  for (const row of rows) entries.push(await entry(row.plan, row.recipe, row.dayStatus, db, now));
  return entries;
}
export async function getPublicationPlanEntry(date: string, db: Database | Tx = getDb(), now?: Date): Promise<PublicationPlanEntry | null> {
  const [row] = await db.select({ plan: editorialPublicationPlans, recipe: editorialRecipes, dayStatus: trendPublicationDays.status }).from(editorialPublicationPlans)
    .innerJoin(editorialRecipes, eq(editorialRecipes.id, editorialPublicationPlans.recipeId))
    .innerJoin(trendPublicationDays, eq(trendPublicationDays.date, editorialPublicationPlans.date)).where(eq(editorialPublicationPlans.date, date));
  return row ? entry(row.plan, row.recipe, row.dayStatus, db, now ?? await wallTime(db)) : null;
}

/** The final release kernel enforces reservations even when called by an older worker. */
export async function assertPublicationPlanSelection(tx: Tx, date: string, recipeId: string, expectedHash: string) {
  await lockPublicationPlan(tx);
  const [plan] = await tx.select().from(editorialPublicationPlans).where(eq(editorialPublicationPlans.date, date));
  if (plan && (plan.recipeId !== recipeId || plan.expectedContentHash !== expectedHash))
    throw new EditorialError(409, 'PUBLICATION_PLAN_MISMATCH', 'Publikacja nie odpowiada przepisowi i treści zarezerwowanym na ten dzień.');
  if (!plan) {
    const [reserved] = await tx.select({ date: editorialPublicationPlans.date }).from(editorialPublicationPlans)
      .where(eq(editorialPublicationPlans.recipeId, recipeId));
    if (reserved) throw new EditorialError(409, 'RECIPE_RESERVED_FOR_PUBLICATION', 'Ten przepis ma rezerwację na inny dzień. Właściciel musi zmienić lub anulować plan.');
  }
}

async function rejectRetiredPublicationPlan(actor: EditorialActor): Promise<never> {
  return getDb().transaction(async tx => {
    await ownerAccount(tx, actor);
    throw new EditorialError(410, 'MANUAL_PUBLICATION_REQUIRED', 'Planowanie publikacji zostało wyłączone. Publikuj ręcznie w edytorze.');
  });
}

/** Historical plans stay readable; fresh owner authorization precedes retirement. */
export async function savePublicationPlan(_entries: PublicationPlanInput[], actor: EditorialActor): Promise<PublicationPlanEntry[]> {
  return rejectRetiredPublicationPlan(actor);
}

export async function removePublicationPlan(_date: string, actor: EditorialActor): Promise<PublicationPlanEntry[]> {
  return rejectRetiredPublicationPlan(actor);
}
