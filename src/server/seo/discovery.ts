import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import type { Recipe } from '@/lib/recipes';
import { getPublishedCollectionDefinitions } from '@/server/collections/store';
import { PUBLIC_SITE_URL, isProductionIndexable } from '@/lib/seo';
import { getDb } from '@/server/db';
import { editorialOutbox, editorialPublications, editorialRecipes, editorialSlugs } from '@/server/db/schema';
import { getPublishedRecipeById } from '@/server/editorial/store';
import { prepareRecipeMedia } from './media';

const leaseMs = 5 * 60 * 1000;
const indexNowEndpoint = 'https://api.indexnow.org/indexnow';
type OutboxRow = typeof editorialOutbox.$inferSelect;

export function configuredIndexNowKey(): string | null {
  const key = process.env.INDEXNOW_KEY?.trim();
  return key && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : null;
}

export function discoveryRetryAt(attempt: number, now: Date, retryAfter?: string | null): Date {
  const base = Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(0, attempt - 1), 11));
  const supplied = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now.getTime() : 0;
  return new Date(now.getTime() + Math.min(24 * 60 * 60 * 1000, Math.max(base, Number.isFinite(supplied) ? supplied : 0)));
}

export function discoveryRecipePaths(slugs: Array<{ locale: string; slug: string }>): string[] {
  return [...new Set(slugs.filter(item => ['pl', 'en'].includes(item.locale) && item.slug)
    .map(item => `/${item.locale}/recipes/${encodeURIComponent(item.slug)}`))];
}

export function indexNowPayload(paths: string[], key: string) {
  const site = new URL(PUBLIC_SITE_URL);
  const urlList = [...new Set(paths.map(path => new URL(path, site).toString()))];
  if (urlList.some(url => new URL(url).origin !== site.origin)) throw new Error('INDEXNOW_FOREIGN_ORIGIN');
  return { host: site.hostname, key, keyLocation: new URL('/indexnow-key.txt', site).toString(), urlList };
}

/** Atomic expiring lease: repeated cron calls cannot process the same event concurrently. */
async function claim(eventId?: string, workflow?: { id: string; generation: number }): Promise<OutboxRow | null> {
  return getDb().transaction(async tx => {
    const now = new Date();
    const [row] = await tx.select().from(editorialOutbox)
      .where(and(isNull(editorialOutbox.processedAt), ...(eventId ? [eq(editorialOutbox.id, eventId)] : []),
        ...(workflow ? [eq(editorialOutbox.discoveryWorkflowId, workflow.id),eq(editorialOutbox.discoveryGeneration, workflow.generation)] : []), lte(editorialOutbox.nextAttemptAt, now),
        or(isNull(editorialOutbox.leaseExpiresAt), lte(editorialOutbox.leaseExpiresAt, now))))
      .orderBy(asc(editorialOutbox.createdAt)).for('update', { skipLocked: true }).limit(1);
    if (!row) return null;
    const [leased] = await tx.update(editorialOutbox).set({ status: 'processing', attempts: row.attempts + 1,
      leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + leaseMs) }).where(eq(editorialOutbox.id, row.id)).returning();
    return leased;
  });
}

type DiscoveryDependencies = {
  production: () => boolean;
  prepareMedia: (recipe: Recipe) => Promise<void>;
  revalidate: (path: string, type?: 'page' | 'layout') => void;
  request: typeof fetch;
};
const defaultDependencies: DiscoveryDependencies = { production: isProductionIndexable, prepareMedia: prepareRecipeMedia,
  revalidate: revalidatePath, request: (...args) => fetch(...args) };

export async function processDiscoveryOutbox(options: { limit?: number; eventId?: string; workflow?: { id: string; generation: number }; dependencies?: Partial<DiscoveryDependencies> } = {}) {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const result = { enabled: dependencies.production(), completed: 0, retries: 0, claimed: 0 };
  // Preview/dev shares can never submit production URLs or consume their pending events.
  if (!result.enabled) return result;
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  for (let index = 0; index < limit; index++) {
    const row = await claim(options.eventId, options.workflow);
    if (!row) break;
    result.claimed++;
    const owned = and(eq(editorialOutbox.id, row.id), eq(editorialOutbox.leaseToken, row.leaseToken!));
    let responseStatus: number | null = null;
    let retryAfter: string | null = null;
    try {
      const slugs = await getDb().select({ locale: editorialSlugs.locale, slug: editorialSlugs.slug })
        .from(editorialSlugs).where(eq(editorialSlugs.recipeId, row.recipeId));
      const recipePaths = discoveryRecipePaths(slugs);
      const collectionPaths = (await getPublishedCollectionDefinitions()).flatMap(collection => (['pl','en'] as const).map(locale => `/${locale}/kolekcje/${collection.slug[locale]}`));
      const recipe = await getPublishedRecipeById(row.recipeId);
      // Preparing derivatives also covers pre-existing publication events.
      if (recipe) await dependencies.prepareMedia(recipe);
      if (!row.cacheProcessedAt) {
        await (await import('../public/read-model')).refreshPublicReadModel();
        for (const path of ['/', '/pl', '/en', '/sitemap.xml', '/pl/feed.xml', '/en/feed.xml', ...recipePaths]) dependencies.revalidate(path);
        dependencies.revalidate('/[locale]/kolekcje/[slug]', 'page');
        dependencies.revalidate('/[locale]/poradniki/[slug]', 'page');
        dependencies.revalidate('/[locale]/recipes/[slug]', 'page');
        await getDb().update(editorialOutbox).set({ cacheProcessedAt: new Date() }).where(owned);
      }
      if (!recipePaths.length) {
        // A never-published archive has no public address to notify.
        await getDb().update(editorialOutbox).set({ status: 'completed', processedAt: new Date(), lastError: null,
          leaseToken: null, leaseExpiresAt: null }).where(owned);
        result.completed++; continue;
      }
      const key = configuredIndexNowKey();
      if (!key) throw new Error('INDEXNOW_NOT_CONFIGURED');
      const response = await dependencies.request(indexNowEndpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(indexNowPayload([...recipePaths, ...collectionPaths, '/pl', '/en'], key)),
        signal: AbortSignal.timeout(15_000), redirect: 'error' });
      responseStatus = response.status; retryAfter = response.headers.get('retry-after');
      if (response.status !== 200 && response.status !== 202) throw new Error(`INDEXNOW_HTTP_${response.status}`);
      // 202 acknowledges receipt while key validation is pending; it is not an indexing promise.
      await getDb().update(editorialOutbox).set({ status: 'completed', processedAt: new Date(), indexNowStatus: response.status,
        lastError: null, leaseToken: null, leaseExpiresAt: null }).where(owned);
      result.completed++;
    } catch (error) {
      const safeError = error instanceof Error && /^(INDEXNOW_(NOT_CONFIGURED|HTTP_\d+|FOREIGN_ORIGIN))$/.test(error.message)
        ? error.message : 'DISCOVERY_PROCESSING_FAILED';
      const now = new Date();
      const nextAttemptAt = safeError === 'INDEXNOW_NOT_CONFIGURED' ? new Date(now.getTime() + 60 * 60 * 1000)
        : discoveryRetryAt(row.attempts, now, retryAfter);
      await getDb().update(editorialOutbox).set({ status: 'retry', lastError: safeError, indexNowStatus: responseStatus,
        nextAttemptAt, leaseToken: null, leaseExpiresAt: null }).where(owned);
      result.retries++;
    }
  }
  return result;
}

export async function getDiscoveryStatus() {
  const [counts] = await getDb().select({
    pending: sql<number>`count(*) filter (where ${editorialOutbox.processedAt} is null)::int`,
    completed: sql<number>`count(*) filter (where ${editorialOutbox.processedAt} is not null)::int`,
    retries: sql<number>`count(*) filter (where ${editorialOutbox.status}='retry')::int`,
  }).from(editorialOutbox);
  const recent = await getDb().select({ recipeId: editorialOutbox.recipeId, event: editorialOutbox.event,
    status: editorialOutbox.status, attempts: editorialOutbox.attempts, createdAt: editorialOutbox.createdAt,
    processedAt: editorialOutbox.processedAt, nextAttemptAt: editorialOutbox.nextAttemptAt,
    lastError: editorialOutbox.lastError, indexNowStatus: editorialOutbox.indexNowStatus })
    .from(editorialOutbox).orderBy(sql`${editorialOutbox.createdAt} desc`).limit(20);
  return { production: isProductionIndexable(), indexNowConfigured: Boolean(configuredIndexNowKey()), counts, recent };
}


export type DiscoveryDeliveryState = {
  status: 'pending' | 'completed' | 'superseded'; serverNow: string; nextAttemptAt: string;
};
export type DiscoveryDispatchLease = { eventId: string; generation: number; token: string };

/** Dispatch leases fence ambiguous/lost starts without relying on SDK start idempotency. */
export async function reserveDiscoveryWorkflow(eventId: string, previous?: { id: string; generation: number }): Promise<DiscoveryDispatchLease | null> {
  return getDb().transaction(async tx => {
    const now = new Date();
    const [row] = await tx.select().from(editorialOutbox).where(eq(editorialOutbox.id,eventId)).for('update');
    if (!row || row.processedAt) return null;
    if (row.discoveryWorkflowId && (!previous || row.discoveryWorkflowId !== previous.id || row.discoveryGeneration !== previous.generation)) return null;
    if (!row.discoveryWorkflowId && row.discoveryDispatchExpiresAt && row.discoveryDispatchExpiresAt.getTime() > now.getTime()) return null;
    const generation = row.discoveryGeneration + Number(Boolean(row.discoveryWorkflowId || row.discoveryDispatchToken));
    const token = randomUUID();
    await tx.update(editorialOutbox).set({ discoveryWorkflowId: null, discoveryGeneration: generation,
      discoveryDispatchToken: token, discoveryDispatchExpiresAt: new Date(now.getTime()+10*60*1_000) }).where(eq(editorialOutbox.id,eventId));
    return { eventId, generation, token };
  });
}

/** Both the dispatcher and the first durable step may attach the same winning run. */
export async function attachDiscoveryWorkflow(eventId: string, generation: number, token: string, workflowId: string): Promise<boolean> {
  return getDb().transaction(async tx => {
    const [row] = await tx.select().from(editorialOutbox).where(eq(editorialOutbox.id,eventId)).for('update');
    if (!row || row.discoveryGeneration !== generation) return false;
    if (row.discoveryWorkflowId) return row.discoveryWorkflowId === workflowId;
    if (row.processedAt) return false;
    if (row.discoveryDispatchToken !== token || !row.discoveryDispatchExpiresAt || row.discoveryDispatchExpiresAt.getTime() < Date.now()) return false;
    await tx.update(editorialOutbox).set({ discoveryWorkflowId: workflowId, discoveryDispatchToken: null, discoveryDispatchExpiresAt: null }).where(eq(editorialOutbox.id,eventId));
    return true;
  });
}

export async function getDiscoveryDeliveryState(eventId: string, generation: number, workflowId: string): Promise<DiscoveryDeliveryState> {
  const now = new Date();
  const [row] = await getDb().select().from(editorialOutbox).where(eq(editorialOutbox.id,eventId));
  if (!row || row.processedAt) return { status: 'completed',serverNow:now.toISOString(),nextAttemptAt:now.toISOString() };
  if (row.discoveryGeneration !== generation || row.discoveryWorkflowId !== workflowId) return { status:'superseded',serverNow:now.toISOString(),nextAttemptAt:now.toISOString() };
  const next = Math.max(row.nextAttemptAt.getTime(),row.leaseExpiresAt?.getTime() ?? 0);
  return { status:'pending',serverNow:now.toISOString(),nextAttemptAt:new Date(next).toISOString() };
}


/** One owner-requested SEO rollout event for each current immutable public snapshot. */
export async function queuePublishedDiscoveryBackfill(production = isProductionIndexable()) {
  if (!production) return { enabled:false,queued:0,total:0 };
  return getDb().transaction(async tx => {
    const publications=await tx.select({ id:editorialPublications.id,recipeId:editorialPublications.recipeId,revision:editorialPublications.revision })
      .from(editorialRecipes).innerJoin(editorialPublications,eq(editorialRecipes.publishedId,editorialPublications.id))
      .where(and(eq(editorialRecipes.publicationStatus,'published'), isNull(editorialRecipes.deletedAt)));
    if (!publications.length) return {enabled:true,queued:0,total:0};
    // Publication IDs are immutable UUIDs. Replaying this action never creates
    // another backfill for the same snapshot or changes any publication dates.
    const queued=await tx.insert(editorialOutbox).values(publications.map(publication=>({
      id:publication.id,recipeId:publication.recipeId,revision:publication.revision,event:'seo_backfill',
    }))).onConflictDoNothing().returning({id:editorialOutbox.id});
    return {enabled:true,queued:queued.length,total:publications.length};
  });
}
