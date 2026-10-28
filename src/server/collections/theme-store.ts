import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/server/db';
import type { EditorialActor } from '@/lib/editorial-types';
import { defaultCollectionPalette } from '@/lib/collections';
import type { GenerationDto } from '@/lib/collection-theme-types';
import { aiSettings } from '@/server/ai/config';
import { budget, budgetLock } from '@/server/ai/store';
import { ProviderError } from '@/server/ai/provider-error';
import { ensurePhotoStorageAvailable } from '@/server/media/capacity';
import { assertCollectionActor, getCollection, lockedCollection, saveCollectionInTransaction } from './store';
import { collectionAssets, collectionThemeCosts, collectionThemeGenerations as generations, collectionThemeJobs as jobs } from './theme-schema';
import { CollectionError } from './errors';
import { collectionThemeSchema } from './validation';
import { readCollectionAsset, saveCollectionAsset, themeAsset } from './media';
import { pollThemeImage, pollThemeSpec, submitThemeImage, submitThemeSpec, uploadThemeReference, themeProviderCost } from './theme-provider';

export const createThemeInput = z.object({ expectedRevision: z.number().int().positive(), brief: z.string().trim().min(10).max(8000),
  part: z.enum(['all', 'hero', 'background']), inspirationAssetId: z.string().uuid().nullable(), requestKey: z.string().uuid() }).strict();
type Generation = typeof generations.$inferSelect;
type Job = typeof jobs.$inferSelect;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function generationRow(id: string, db: ReturnType<typeof getDb> | Tx = getDb()) {
  const [row] = await db.select().from(generations).where(eq(generations.id, id));
  if (!row) throw new CollectionError(404, 'GENERATION_NOT_FOUND', 'Nie znaleziono wersji wyglądu.');
  return row;
}
async function dto(row: Generation, db: ReturnType<typeof getDb> | Tx = getDb()): Promise<GenerationDto> {
  const children = await db.select({ chargedUsd: jobs.chargedUsd }).from(jobs).where(eq(jobs.generationId, row.id));
  const known = children.length > 0 && children.every(child => child.chargedUsd !== null);
  return { id: row.id, collectionId: row.collectionId, status: row.status, part: row.part, brief: row.brief,
    theme: row.theme, error: row.error, createdAt: row.createdAt.toISOString(), appliedRevision: row.appliedRevision,
    chargedUsd: known ? children.reduce((sum, child) => sum.plus(child.chargedUsd!), new Decimal(0)).toFixed(8) : null };
}
export async function listThemeGenerations(collectionId: string) {
  const rows = await getDb().select().from(generations).where(eq(generations.collectionId, collectionId)).orderBy(desc(generations.createdAt)).limit(40);
  return Promise.all(rows.map(row => dto(row)));
}
export async function getThemeGeneration(collectionId: string, id: string) {
  const row = await generationRow(id);
  return row.collectionId === collectionId ? dto(row) : null;
}
export { assertThemeAssets } from './theme-approval';
export { collectionGenerationBudget } from './theme-budget';
export async function reconcileThemeCosts(collectionId: string) {
  const pending = await getDb().select({ job: jobs }).from(jobs).innerJoin(generations, eq(jobs.generationId, generations.id))
    .where(and(eq(generations.collectionId, collectionId), isNull(jobs.chargedUsd), isNotNull(jobs.providerRequestId), isNotNull(jobs.providerFinishedAt))).limit(12);
  for (const { job } of pending) {
    try {
      const amount = await themeProviderCost(job.kind, job.model, job.providerRequestId!);
      if (amount !== null) await getDb().transaction(tx => settleJob(tx, job.id, amount));
    } catch { /* Billing reads are retried later without creating another generation. */ }
  }
}

export async function createThemeGeneration(collectionId: string, value: unknown, actor: EditorialActor) {
  const input = createThemeInput.parse(value);
  const settings = aiSettings();
  if (!settings.openai || !settings.fal || !settings.storage) throw new CollectionError(503, 'GENERATOR_NOT_CONFIGURED', 'Podłączone usługi generowania i magazyn grafik muszą być dostępne.');
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    await assertCollectionActor(tx, actor);
    const hash = createHash('sha256').update(JSON.stringify([collectionId, input.expectedRevision, input.part, input.brief, input.inspirationAssetId])).digest('hex');
    const [prior] = await tx.select().from(generations).where(and(eq(generations.createdBy, actor.id), eq(generations.requestKey, input.requestKey)));
    if (prior) {
      if (prior.inputHash !== hash) throw new CollectionError(409, 'REQUEST_KEY_REUSED', 'Identyfikator dotyczy innego zlecenia. Odśwież formularz.');
      return dto(prior, tx);
    }
    const record = await lockedCollection(tx, collectionId, input.expectedRevision);
    if (input.part !== 'all' && !record.content.theme) throw new CollectionError(422, 'BASE_THEME_REQUIRED', 'Najpierw wygeneruj i zaakceptuj pełny wygląd.');
    if (input.inspirationAssetId) {
      const [reference] = await tx.select().from(collectionAssets).where(and(eq(collectionAssets.id, input.inspirationAssetId), eq(collectionAssets.collectionId, collectionId), eq(collectionAssets.kind, 'inspiration')));
      if (!reference) throw new CollectionError(422, 'INSPIRATION_NOT_FOUND', 'Wybierz inspirację należącą do tej kolekcji.');
    }
    const [duplicate] = await tx.select().from(generations).where(and(eq(generations.collectionId, collectionId), eq(generations.inputHash, hash), inArray(generations.status, ['queued', 'running', 'uncertain'])));
    if (duplicate) return dto(duplicate, tx);
    const [row] = await tx.insert(generations).values({ id: randomUUID(), collectionId, baseRevision: input.expectedRevision,
      brief: input.brief, part: input.part, inspirationAssetId: input.inspirationAssetId, baseTheme: record.content.theme,
      input: { title: record.content.title, description: record.content.description, imageModel: settings.imageModel }, createdBy: actor.id, requestKey: input.requestKey, inputHash: hash }).returning();
    await tx.insert(jobs).values({ id: randomUUID(), generationId: row.id, kind: 'spec', model: settings.recipeModel });
    return dto(row, tx);
  });
}

/** A hero uploaded from disk becomes a ready, cost-free version that goes through the same preview and approval as generated ones.
 * Hero assets must reference their version, so the version is reserved as failed first and only becomes ready with its asset. */
export async function uploadThemeHero(collectionId: string, bytes: Buffer, actor: EditorialActor) {
  const reserved = await reserveUploadedHero(collectionId, actor);
  return completeUploadedHero(reserved, await saveCollectionAsset({ collectionId, kind: 'hero', bytes, generationId: reserved.id }));
}
export async function reserveUploadedHero(collectionId: string, actor: EditorialActor) {
  return getDb().transaction(async tx => {
    await assertCollectionActor(tx, actor);
    const record = await getCollection(collectionId, tx);
    const id = randomUUID();
    const [row] = await tx.insert(generations).values({ id, collectionId, baseRevision: record.revision, brief: 'Grafika główna wgrana z dysku.',
      part: 'hero', inspirationAssetId: null, baseTheme: record.content.theme, status: 'failed', error: 'Przesyłanie grafiki nie zostało dokończone. Wgraj plik ponownie.',
      input: { title: record.content.title, description: record.content.description }, createdBy: actor.id, requestKey: randomUUID(),
      inputHash: createHash('sha256').update(JSON.stringify([collectionId, 'upload', id])).digest('hex') }).returning();
    return row;
  });
}
export async function completeUploadedHero(reserved: Generation, asset: typeof collectionAssets.$inferSelect) {
  const base = reserved.baseTheme;
  const alt = base?.hero.alt ?? { pl: reserved.input.title.pl.trim() || 'Grafika kolekcji', en: reserved.input.title.en.trim() || 'Collection artwork' };
  const theme = collectionThemeSchema.parse({ version: 1, palette: base?.palette ?? defaultCollectionPalette,
    decorationOpacity: base?.decorationOpacity ?? 0, hero: themeAsset(asset, alt), atmosphere: base?.atmosphere ?? null });
  const [row] = await getDb().update(generations).set({ theme, status: 'ready', error: null, updatedAt: new Date() }).where(eq(generations.id, reserved.id)).returning();
  return dto(row);
}

export async function applyThemeGeneration(collectionId: string, generationId: string, expectedRevision: number, actor: EditorialActor) {
  return getDb().transaction(async tx => {
    await assertCollectionActor(tx, actor);
    const record = await getCollection(collectionId, tx);
    const generation = await generationRow(generationId, tx);
    if (generation.collectionId !== collectionId || generation.status !== 'ready' || !generation.theme) throw new CollectionError(409, 'THEME_NOT_READY', 'Ta wersja wyglądu nie jest jeszcze gotowa.');
    const result = await saveCollectionInTransaction(tx, collectionId, { expectedRevision, content: { ...record.content,
      theme: generation.theme, themeGenerationId: generation.id, appearanceBrief: generation.brief, inspirationAssetId: generation.inspirationAssetId } }, actor, { allowThemeChange: true });
    await tx.update(generations).set({ appliedRevision: result.revision, updatedAt: new Date() }).where(eq(generations.id, generation.id));
    return result;
  });
}

export async function claimThemeDispatch(id: string) {
  return getDb().transaction(async tx => {
    const [row] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (!row || ['ready', 'failed', 'uncertain'].includes(row.status) || row.dispatchExpiresAt && row.dispatchExpiresAt.getTime() > Date.now()) return null;
    const token = randomUUID();
    await tx.update(generations).set({ dispatchToken: token, dispatchExpiresAt: new Date(Date.now() + 30 * 60_000), updatedAt: new Date() }).where(eq(generations.id, id));
    return token;
  });
}
export async function attachThemeWorkflow(id: string, token: string, workflowId: string) {
  await getDb().update(generations).set({ workflowId }).where(and(eq(generations.id, id), eq(generations.dispatchToken, token)));
}
export async function resumeThemeGeneration(collectionId: string, id: string, expectedRevision: number, actor: EditorialActor) {
  return getDb().transaction(async tx => {
    await assertCollectionActor(tx, actor); await lockedCollection(tx, collectionId, expectedRevision);
    const row = await generationRow(id, tx);
    if (row.collectionId !== collectionId) throw new CollectionError(404, 'GENERATION_NOT_FOUND', 'Nie znaleziono wersji wyglądu tej kolekcji.');
    if (row.status === 'ready') return dto(row, tx);
    const children = await tx.select().from(jobs).where(eq(jobs.generationId, id));
    if (children.some(job => ['submitting', 'uncertain'].includes(job.status) && !job.providerRequestId)) throw new CollectionError(409, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zlecenia przez usługę. Nie wysyłamy płatnego zlecenia ponownie.');
    if (children.some(job => job.status === 'failed')) throw new CollectionError(409, 'GENERATION_FAILED', 'Ta propozycja nie została ukończona. Możesz zlecić nową wersję wyglądu.');
    await tx.update(jobs).set({ status: 'generating', error: null, updatedAt: new Date() }).where(and(eq(jobs.generationId, id), eq(jobs.status, 'uncertain')));
    const [updated] = await tx.update(generations).set({ status: 'queued', error: null, dispatchExpiresAt: null, workflowId: null, updatedAt: new Date() }).where(eq(generations.id, id)).returning();
    return dto(updated, tx);
  });
}

async function settleJob(tx: Tx, jobId: string, chargedUsd: string | null) {
  if (chargedUsd === null) return;
  await tx.update(jobs).set({ chargedUsd }).where(eq(jobs.id, jobId));
  await tx.insert(collectionThemeCosts).values({ jobId, amountUsd: chargedUsd }).onConflictDoNothing();
}
async function finishJob(job: Job, result: Job['result'], chargedUsd: string | null) {
  await getDb().transaction(async tx => {
    await tx.update(jobs).set({ status: 'ready', result, providerFinishedAt: new Date(), error: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
    await settleJob(tx, job.id, chargedUsd);
  });
}
async function markFailure(id: string, jobId: string | null, message: string, uncertain: boolean, chargedUsd: string | null = null, token?: string) {
  await getDb().transaction(async tx => {
    const [owner] = await tx.select({ token: generations.dispatchToken, status: generations.status }).from(generations).where(eq(generations.id, id)).for('update');
    if (!owner || owner.status === 'ready' || token && owner.token !== token) return;
    if (jobId) {
      await tx.update(jobs).set({ status: uncertain ? 'uncertain' : 'failed', error: message,
        providerFinishedAt: uncertain ? null : new Date(), updatedAt: new Date() }).where(eq(jobs.id, jobId));
      await settleJob(tx, jobId, chargedUsd);
    }
    await tx.update(generations).set({ status: uncertain ? 'uncertain' : 'failed', error: message, dispatchExpiresAt: null, updatedAt: new Date() }).where(eq(generations.id, id));
  });
}
export async function stopThemeGeneration(id: string, message: string, token?: string) { await markFailure(id, null, message, true, null, token); }

async function assertThemeSubmission(id: string, token: string, jobId: string, actorId: string) {
  await getDb().transaction(async tx => {
    const [generation] = await tx.select().from(generations).where(eq(generations.id, id)).for('share');
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('share');
    if (!generation || generation.dispatchToken !== token || generation.status !== 'running' || !job || job.status !== 'submitting' || job.providerRequestId) throw new CollectionError(409, 'SUBMISSION_SUPERSEDED', 'To zlecenie zostało już zatrzymane lub przejęte przez nowszy odczyt.');
    await assertCollectionActor(tx, { id: actorId } as EditorialActor);
  });
}

async function nextJob(id: string, token: string) {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const [row] = await tx.select().from(generations).where(eq(generations.id, id)).for('update');
    if (!row || row.dispatchToken !== token || ['ready', 'failed', 'uncertain'].includes(row.status)) return { state: 'done' as const };
    const children = (await tx.select().from(jobs).where(eq(jobs.generationId, id))).sort((a, b) => ['spec', 'hero', 'atmosphere'].indexOf(a.kind) - ['spec', 'hero', 'atmosphere'].indexOf(b.kind));
    const next = children.find(job => job.status !== 'ready');
    if (!next) return { state: 'assemble' as const, generation: row, children };
    if (['failed', 'uncertain'].includes(next.status)) return { state: 'done' as const };
    if (next.status === 'submitting') {
      if (next.updatedAt.getTime() < Date.now() - 120_000) return { state: 'uncertain' as const, job: next };
      return { state: 'wait' as const };
    }
    if (next.status === 'generating') return { state: 'poll' as const, generation: row, job: next };
    // The live role is rechecked before each new provider submission.
    await assertCollectionActor(tx, { id: row.createdBy } as EditorialActor);
    if ((await budget(tx)).activeJobs >= aiSettings().concurrentLimit) return { state: 'wait' as const };
    const [claimed] = await tx.update(jobs).set({ status: 'submitting', updatedAt: new Date() }).where(eq(jobs.id, next.id)).returning();
    await tx.update(generations).set({ status: 'running', updatedAt: new Date() }).where(eq(generations.id, id));
    return { state: 'submit' as const, generation: row, job: claimed };
  });
}

const themeExecution = { ensureStorage: ensurePhotoStorageAvailable, readAsset: readCollectionAsset, saveAsset: saveCollectionAsset,
  submitSpec: submitThemeSpec, pollSpec: pollThemeSpec, uploadReference: uploadThemeReference, submitImage: submitThemeImage, pollImage: pollThemeImage };
export type ThemeExecutionDependencies = typeof themeExecution;
/** A single advance submits at most once, or reads an existing provider receipt. */
export async function advanceThemeGeneration(id: string, token: string, overrides: Partial<ThemeExecutionDependencies> = {}): Promise<boolean> {
  const execution = { ...themeExecution, ...overrides };
  const operation = await nextJob(id, token);
  if (operation.state === 'done') return true;
  if (operation.state === 'wait') return false;
  if (operation.state === 'uncertain') { await markFailure(id, operation.job.id, 'Nie potwierdzono przyjęcia zlecenia. Nie wysyłamy go ponownie.', true, null, token); return true; }
  if (operation.state === 'assemble') {
    const { generation, children } = operation;
    const proposal = generation.proposal;
    if (!proposal) { await markFailure(id, null, 'Nie znaleziono projektu oprawy.', false, null, token); return true; }
    const assetFor = async (kind: 'hero' | 'atmosphere') => {
      const child = children.find(job => job.kind === kind);
      if (!child) return kind === 'hero' ? generation.baseTheme?.hero : generation.baseTheme?.atmosphere;
      const result = child.result as { assetId: string } | null;
      const [asset] = result ? await getDb().select().from(collectionAssets).where(eq(collectionAssets.id, result.assetId)) : [];
      return asset ? themeAsset(asset, kind === 'hero' ? proposal.heroAlt : proposal.atmosphereAlt) : null;
    };
    const hero = await assetFor('hero'), atmosphere = await assetFor('atmosphere');
    if (!hero) { await markFailure(id, null, 'Brakuje dedykowanej grafiki kolekcji.', false, null, token); return true; }
    const theme = collectionThemeSchema.parse({ version: 1, palette: generation.part === 'hero' ? generation.baseTheme!.palette : proposal.palette,
      decorationOpacity: generation.part === 'hero' ? generation.baseTheme!.decorationOpacity : proposal.decorationOpacity, hero, atmosphere: atmosphere ?? null });
    await getDb().update(generations).set({ theme, status: 'ready', dispatchExpiresAt: null, error: null, updatedAt: new Date() }).where(and(eq(generations.id, id), eq(generations.dispatchToken, token)));
    return true;
  }
  const { generation, job } = operation;
  if (operation.state === 'submit') {
    let submitting = false;
    try {
      await execution.ensureStorage();
      // Reference preparation is non-billable and occurs before the provider POST.
      const reference = generation.inspirationAssetId ? await execution.readAsset(generation.collectionId, generation.inspirationAssetId, 'inspiration') : null;
      let requestId: string, model = job.model;
      if (job.kind === 'spec') {
        await assertThemeSubmission(id, token, job.id, generation.createdBy);
        submitting = true;
        requestId = await execution.submitSpec(job.id, model, { ...generation.input, brief: generation.brief, part: generation.part, baseTheme: generation.baseTheme }, reference?.bytes);
      } else {
        const references: string[] = [];
        if (reference) references.push(await execution.uploadReference(reference.bytes));
        const heroJob = (await getDb().select().from(jobs).where(and(eq(jobs.generationId, id), eq(jobs.kind, 'hero'))))[0];
        const heroAsset = heroJob?.result && 'assetId' in heroJob.result ? heroJob.result.assetId : generation.baseTheme?.hero.assetId;
        if ((job.kind === 'atmosphere' || generation.part === 'hero') && heroAsset) {
          const hero = await execution.readAsset(generation.collectionId, heroAsset, 'hero');
          if (hero) references.push(await execution.uploadReference(hero.bytes));
        }
        if (!generation.proposal) throw new Error('THEME_PROPOSAL_MISSING');
        await assertThemeSubmission(id, token, job.id, generation.createdBy);
        submitting = true;
        const receipt = await execution.submitImage(model, job.kind, generation.proposal, references);
        requestId = receipt.requestId; model = receipt.model;
      }
      await getDb().update(jobs).set({ status: 'generating', providerRequestId: requestId, model, updatedAt: new Date() }).where(eq(jobs.id, job.id));
    } catch (error) {
      const uncertainty = submitting && (!(error instanceof ProviderError) || error.uncertain);
      await markFailure(id, job.id, error instanceof ProviderError ? error.message : uncertainty ? 'Nie potwierdzono przyjęcia generowania. Nowe wysłanie jest zablokowane.' : 'Nie udało się przygotować generowania. Sprawdź magazyn grafik i konfigurację.', uncertainty, !submitting ? '0' : error instanceof ProviderError ? error.chargedUsd ?? (uncertainty ? null : '0') : null, token);
      return true;
    }
    return false;
  }
  if (!job.providerRequestId) { await markFailure(id, job.id, 'Brakuje potwierdzenia przyjęcia zlecenia.', true, null, token); return true; }
  try {
    if (job.kind === 'spec') {
      const result = await execution.pollSpec(job.model, job.providerRequestId);
      if (!result.done) return false;
      await getDb().transaction(async tx => {
        await tx.update(generations).set({ proposal: result.proposal, updatedAt: new Date() }).where(eq(generations.id, id));
        for (const kind of generation.part === 'hero' ? ['hero'] as const : generation.part === 'background' ? ['atmosphere'] as const : ['hero', 'atmosphere'] as const) {
          await tx.insert(jobs).values({ id: randomUUID(), generationId: id, kind, model: generation.input.imageModel ?? aiSettings().imageModel }).onConflictDoNothing();
        }
      });
      await finishJob(job, result.proposal, result.chargedUsd);
    } else {
      const result = await execution.pollImage(job.model, job.providerRequestId);
      if (!result.done) return false;
      const asset = await execution.saveAsset({ id: job.id, collectionId: generation.collectionId, generationId: id, kind: job.kind, bytes: result.bytes });
      await finishJob(job, { assetId: asset.id }, result.chargedUsd);
    }
    return false;
  } catch (error) {
    if (error instanceof ProviderError && !error.uncertain) { await markFailure(id, job.id, error.message, false, error.chargedUsd ?? null, token); return true; }
    // Reads can be repeated safely; no new provider request is created here.
    return false;
  }
}

