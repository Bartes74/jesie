import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { get, put } from '@vercel/blob';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { AiAsset, AiResult } from '@/lib/ai-types';
import type { EditorialActor } from '@/lib/editorial-types';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { applyAiProposalInTransaction } from '@/server/editorial/store';
import { getMediaBlob } from '@/server/media/storage';
import { AiError } from './errors';
import { filledHeroModel, heroCutoutModel } from './image-actions';
import { validateSolidHeroCutout } from './photo-format';
import { samePhotoSubject } from './photo-subject';
import { aiAssets, aiJobs, aiLedger, aiPhotoBatches, ingredientImages } from './schema';
import { capturedIngredientStyleProfile, ingredientImageIdentity, isOpaqueStudioIngredientProfile } from './ingredient-profile';
import type { Ingredient } from '@/lib/recipes';
import { budgetLock, trustedActor, type AiTransaction } from './store';
import { getPhotoBatch } from './photo-batch';

// Use the existing zero-cost local model contract; derivation records the
// reviewed method separately, without weakening the database money constraint.
export const reviewedHeroCorrectionModel = filledHeroModel;
const maximumBytes = 32 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type ReviewedHeroCorrection = {
  batchId: string; generation: number; expectedRevision: number;
  sourceJobId: string; sourceAssetId: string; sourceSha256: string;
  localPath: string; sha256: string; requestKey: string; reviewNote: string;
  applyToDraft?: boolean;
};
export type ReviewedHeroCorrectionStorage = {
  read(pathname: string): Promise<Buffer>;
  ensure(pathname: string, bytes: Buffer, sha256: string): Promise<string>;
};

async function bounded(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
    if (size > maximumBytes) throw new AiError(422, 'PHOTO_SOURCE_INVALID', 'Plik źródłowy jest za duży.'); chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
const storage: ReviewedHeroCorrectionStorage = {
  async read(pathname) {
    const blob = await getMediaBlob(pathname, { useCache: false });
    if (!blob || blob.statusCode !== 200) throw new AiError(503, 'AI_REFERENCE_UNAVAILABLE', 'Nie można odczytać zachowanego oryginału.');
    return bounded(blob.stream);
  },
  async ensure(pathname, bytes, digest) {
    const existing = async () => { const blob = await get(pathname, { access: 'private', useCache: false });
      if (!blob || blob.statusCode !== 200) return false;
      if (sha(await bounded(blob.stream)) !== digest) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Pod tym adresem zapisano inną poprawkę.'); return true; };
    if (await existing()) return pathname;
    try { const saved = await put(pathname, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'image/png' });
      if (saved.pathname !== pathname) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Nie potwierdzono adresu poprawki.'); }
    catch (error) { if (!await existing()) throw error; }
    return pathname;
  },
};

/** Check every source RGB value, including pixels whose previous alpha hid the food. */
export async function verifyReviewedHeroPixels(source: Buffer, corrected: Buffer, sourceSha256: string, correctedSha256: string) {
  if (!source.length || !corrected.length || source.length > maximumBytes || corrected.length > maximumBytes
    || sha(source) !== sourceSha256 || sha(corrected) !== correctedSha256) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Plik nie odpowiada sprawdzonemu manifestowi.');
  const decode = async (bytes: Buffer) => {
    const decoder = sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' });
    const m = await decoder.metadata();
    if (!m.width || !m.height || m.depth !== 'uchar' || (m.pages ?? 1) !== 1 || (m.orientation ?? 1) !== 1) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Fotografia ma nieobsługiwany format.');
    return decoder.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const [original, repaired] = await Promise.all([decode(source), decode(corrected)]);
  const metadata = await sharp(corrected).metadata();
  if (metadata.format !== 'png' || original.info.width !== repaired.info.width || original.info.height !== repaired.info.height) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Poprawka musi być plikiem PNG o dokładnych wymiarach oryginału.');
  for (let offset = 0; offset < original.data.length; offset += 4) {
    if (original.data[offset + 3] !== 255) throw new AiError(422, 'PHOTO_SOURCE_INVALID', 'Źródło musi być pełnym, nieprzezroczystym zdjęciem.');
    if (!original.data.subarray(offset, offset + 3).equals(repaired.data.subarray(offset, offset + 3))) throw new AiError(422, 'SOURCE_PIXELS_CHANGED', 'Poprawka zmienia barwy źródłowej fotografii. Nie zapisano jej.');
  }
  await validateSolidHeroCutout(corrected);
  return { width: repaired.info.width, height: repaired.info.height };
}

function hashInput(input: ReviewedHeroCorrection) {
  return sha(Buffer.from(JSON.stringify({ ...input, localPath: undefined, requestKey: undefined })));
}
async function checkedScope(tx: AiTransaction, input: ReviewedHeroCorrection, actor: EditorialActor) {
  const account = await trustedActor(tx, actor.id);
  const [batch] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, input.batchId)).for('update');
  if (!batch || batch.createdBy !== account.id || batch.generation !== input.generation
    || (input.applyToDraft ? batch.status !== 'applied' || batch.appliedRevision === null : batch.status !== 'ready' || batch.appliedRevision !== null)) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Poprawka wymaga zakończonego pakietu i dokładnie wskazanego trybu zapisu.');
  const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, batch.recipeId)).for('share');
  if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived' || recipe.revision !== input.expectedRevision
    || !samePhotoSubject(batch.input, recipe.content, 'hero', null)) throw new AiError(409, 'REVISION_CONFLICT', 'Stan lub treść przepisu zmieniły się. Zachowano źródło i poprawkę.');
  if (input.applyToDraft && (!['draft', 'in_review'].includes(recipe.editorialStatus) || recipe.publicationStatus !== 'never_published' || recipe.approvedRevision !== null
    || recipe.content.recipe.image !== `/media/${input.sourceAssetId}`)) throw new AiError(409, 'DRAFT_PHOTO_CHANGED', 'Poprawka wymaga niezatwierdzonego szkicu, w którym nadal jest dokładnie sprawdzone zdjęcie.');
  const slotIndex = batch.slots.findIndex(slot => slot.kind === 'hero' && slot.targetId === null && slot.jobId === input.sourceJobId);
  const children = await tx.select().from(aiJobs).where(inArray(aiJobs.id, batch.slots.flatMap(slot => slot.jobId ? [slot.jobId] : [])));
  if (slotIndex < 0 || children.length !== batch.slots.length || children.some(job => !['ready', 'applied'].includes(job.status) || !job.result?.asset && !job.result?.reusedPhoto)) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Pakiet lub wybrane zdjęcie nie są gotowe. Nie zastąpiono żadnego zlecenia.');
  const [sourceJob] = await tx.select().from(aiJobs).where(eq(aiJobs.id, input.sourceJobId)).for('share');
  const [sourceAsset] = await tx.select().from(aiAssets).where(eq(aiAssets.id, input.sourceAssetId)).for('share');
  if (!sourceJob || !sourceAsset || sourceJob.kind !== 'hero' || sourceJob.targetId !== null || sourceJob.recipeId !== recipe.id
    || sourceJob.photoBatchId !== batch.id || sourceJob.model !== heroCutoutModel || sourceJob.provider !== 'fal'
    || !['ready', 'applied'].includes(sourceJob.status) || !sourceJob.providerRequestId || !sourceJob.providerFinishedAt
    || sourceJob.result?.asset?.id !== sourceAsset.id || sourceAsset.jobId !== sourceJob.id || sourceAsset.kind !== 'hero'
    || sourceAsset.model !== heroCutoutModel || sourceAsset.recipeId !== recipe.id || !sourceAsset.originalBlobPathname
    || !samePhotoSubject(sourceJob.input, recipe.content, 'hero', null)) throw new AiError(422, 'INVALID_CORRECTION_SOURCE', 'Wybierz zarejestrowaną, zakończoną maskę tego dania z zachowanym oryginałem.');
  return { account, batch, recipe, slotIndex, sourceJob, sourceAsset };
}

/** Operator-only, pixel-preserving local repair: no paid provider calls or replacement packets. */
export async function importReviewedHeroCorrection(input: ReviewedHeroCorrection, actor: EditorialActor, io: ReviewedHeroCorrectionStorage = storage) {
  if (![input.batchId, input.sourceJobId, input.sourceAssetId].every(id => /^[a-f0-9-]{36}$/i.test(id))
    || !Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !isAbsolute(input.localPath) || ![input.sha256, input.sourceSha256].every(digest => /^[a-f0-9]{64}$/.test(digest))
    || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey) || !input.reviewNote.trim() || input.reviewNote.length > 1000) throw new AiError(422, 'INVALID_INPUT', 'Uzupełnij dokładny manifest sprawdzonej poprawki.');
  const inputHash = hashInput(input);
  const existing = async (tx: AiTransaction) => {
    await trustedActor(tx, actor.id);
    const [job] = await tx.select().from(aiJobs).where(and(eq(aiJobs.createdBy, actor.id), eq(aiJobs.requestKey, input.requestKey)));
    if (!job) return null;
    if (job.photoBatchId !== input.batchId || job.inputHash !== inputHash || job.model !== reviewedHeroCorrectionModel) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator został użyty dla innej poprawki.');
    return job;
  };
  const preflight = await getDb().transaction(async tx => { await budgetLock(tx); const prior = await existing(tx);
    if (prior) return { prior }; return { scope: await checkedScope(tx, input, actor) }; });
  if (preflight.prior) return getPhotoBatch(input.batchId);
  const original = await io.read(preflight.scope!.sourceAsset.originalBlobPathname!);
  const corrected = await readFile(input.localPath);
  const size = await verifyReviewedHeroPixels(original, corrected, input.sourceSha256, input.sha256);
  if (size.width !== preflight.scope!.sourceAsset.width || size.height !== preflight.scope!.sourceAsset.height) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Wymiary oryginału nie odpowiadają zarejestrowanemu zdjęciu.');
  const pathname = `ai/reviewed-hero/${input.batchId}/${inputHash}.png`;
  if (await io.ensure(pathname, corrected, input.sha256) !== pathname) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Nie potwierdzono adresu poprawki.');
  await getDb().transaction(async tx => {
    await budgetLock(tx); if (await existing(tx)) return;
    const { account, batch, recipe, slotIndex, sourceJob, sourceAsset } = await checkedScope(tx, input, actor);
    if (sourceAsset.originalBlobPathname !== preflight.scope!.sourceAsset.originalBlobPathname) throw new AiError(409, 'INVALID_CORRECTION_SOURCE', 'Ścieżka oryginału zmieniła się.');
    const id = randomUUID(); const now = new Date();
    const asset: AiAsset = { id, jobId: id, recipeId: recipe.id, kind: 'hero', targetId: null, src: `/media/${id}`,
      ...size, model: reviewedHeroCorrectionModel, alt: sourceAsset.alt, caption: sourceAsset.caption,
      styleProfile: sourceJob.input.aiPhotography?.heroStyleProfile, createdAt: now.toISOString() };
    const result: AiResult = { content: null, asset, notes: ['Poprawiono wyłącznie maskę zachowanej fotografii. Zweryfikowano zgodność wszystkich pikseli RGB oryginału, bez nowego płatnego zgłoszenia.', input.reviewNote],
      derivation: { method: 'deterministic_hero_mask_repair', sourceJobId: sourceJob.id, sourceAssetId: sourceAsset.id, sha256: input.sha256, sourceSha256: input.sourceSha256 } };
    await tx.insert(aiJobs).values({ id, photoBatchId: batch.id, recipeId: recipe.id, baseRevision: recipe.revision, kind: 'hero', targetId: null,
      status: 'ready', provider: 'fal', model: reviewedHeroCorrectionModel, brief: input.reviewNote, requestKey: input.requestKey, inputHash,
      input: structuredClone(sourceJob.input), createdBy: account.id, createdByName: account.name, reservedUsd: '0', chargedUsd: '0', costBasis: 'usage',
      providerFinishedAt: now, result });
    await tx.insert(aiAssets).values({ id, jobId: id, recipeId: recipe.id, kind: 'hero', targetId: null, blobPathname: pathname,
      originalBlobPathname: sourceAsset.originalBlobPathname, ...size, contentType: 'image/png', alt: sourceAsset.alt, caption: sourceAsset.caption, model: reviewedHeroCorrectionModel });
    await tx.insert(aiLedger).values(['reserve', 'settle'].map(entry => ({ id: randomUUID(), jobId: id, entry: entry as 'reserve' | 'settle', amountUsd: '0', basis: 'not_charged' as const })));
    if (input.applyToDraft) {
      const content = structuredClone(recipe.content); content.recipe.image = `/media/${id}`;
      const correctedRecipe = await applyAiProposalInTransaction(tx, recipe.id, input.expectedRevision, content, account, 'Poprawienie maski zachowanej fotografii, bez nowego płatnego zdjęcia');
      await tx.update(aiJobs).set({ status: 'applied', appliedRevision: correctedRecipe.revision, updatedAt: now }).where(eq(aiJobs.id, id));
      // The earlier applied packet is historical evidence: keep every old
      // slot, its application revision and terminal status exactly as saved.
    } else {
      const slots = structuredClone(batch.slots); slots[slotIndex].jobId = id;
      await tx.update(aiPhotoBatches).set({ slots, updatedAt: now }).where(eq(aiPhotoBatches.id, batch.id));
    }
  });
  return getPhotoBatch(input.batchId);
}

export type ReviewedLiquidCreamReuse = {
  batchId: string; generation: number; expectedRevision: number; targetId: string;
  replacedJobId: string; sourceJobId: string; sourceAssetId: string; sourceSha256: string;
  requestKey: string; reviewNote: string;
};
function creamRange(ingredient: Pick<Ingredient, 'name'>): [number, number] | null {
  const pl = ingredient.name.pl.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const en = ingredient.name.en.toLowerCase();
  const polish = /^smietanka(?: kremowka)?(?: (\d+)%(?: lub (\d+)%)?)?$/.exec(pl);
  const english = /^(?:whipping|heavy|double) cream(?:,? (\d+)(?:[–-](\d+))?% fat)?$/.exec(en);
  if (!polish || !english) return null;
  const numbers = [polish[1] ?? '30', polish[2] ?? polish[1] ?? '30', english[1] ?? '30', english[2] ?? english[1] ?? '30'].map(Number);
  if (numbers[0] !== numbers[2] || numbers[1] !== numbers[3]) return null;
  return [numbers[0], numbers[1]];
}
/** A reviewed 30–36% liquid photograph includes the specified 30% liquid form. */
export function sameLiquidCreamPhotoForm(target: Pick<Ingredient, 'name' | 'note'>, source: Pick<Ingredient, 'name' | 'note'>) {
  const wanted = creamRange(target), available = creamRange(source);
  return Boolean(wanted && available && wanted[0] >= available[0] && wanted[1] <= available[1]
    && !/\b(?:whipped|ubita|ubite|bita)\b/.test(`${source.note?.pl ?? ''} ${source.note?.en ?? ''}`.toLowerCase()));
}

/** Exact existing liquid cream, reviewed once; no model invocation or altered source pixels. */
export async function reuseReviewedLiquidCream(input: ReviewedLiquidCreamReuse, actor: EditorialActor, io: ReviewedHeroCorrectionStorage = storage) {
  if (![input.batchId, input.replacedJobId, input.sourceJobId, input.sourceAssetId].every(id => /^[a-f0-9-]{36}$/i.test(id))
    || !Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !/^[A-Za-z0-9_-]{1,100}$/.test(input.targetId) || !/^[a-f0-9]{64}$/.test(input.sourceSha256)
    || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey) || !input.reviewNote.trim() || input.reviewNote.length > 1000) throw new AiError(422, 'INVALID_INPUT', 'Uzupełnij manifest sprawdzonego zdjęcia płynnej śmietanki.');
  const inputHash = sha(Buffer.from(JSON.stringify({ ...input, requestKey: undefined })));
  const model = 'jesie/reviewed-liquid-cream-reuse-v1';
  const check = async (tx: AiTransaction) => {
    const account = await trustedActor(tx, actor.id);
    const [prior] = await tx.select().from(aiJobs).where(and(eq(aiJobs.createdBy, account.id), eq(aiJobs.requestKey, input.requestKey)));
    if (prior) {
      if (prior.inputHash !== inputHash || prior.photoBatchId !== input.batchId || prior.model !== model) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator dotyczy innej poprawki.');
      return { prior };
    }
    const [batch] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, input.batchId)).for('update');
    if (!batch || batch.createdBy !== account.id || batch.status !== 'ready' || batch.generation !== input.generation || batch.appliedRevision !== null) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Zaczekaj na zakończenie tego pakietu przed poprawieniem zdjęcia.');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, batch.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived' || recipe.revision !== input.expectedRevision || !samePhotoSubject(batch.input, recipe.content, 'hero', null)) throw new AiError(409, 'REVISION_CONFLICT', 'Przepis zmienił się od sprawdzenia zdjęcia.');
    const slotIndex = batch.slots.findIndex(slot => slot.kind === 'ingredient' && slot.targetId === input.targetId && slot.jobId === input.replacedJobId);
    const children = await tx.select().from(aiJobs).where(inArray(aiJobs.id, batch.slots.flatMap(slot => slot.jobId ? [slot.jobId] : [])));
    if (slotIndex < 0 || children.length !== batch.slots.length || children.some(job => !['ready', 'applied'].includes(job.status) || !job.result?.asset && !job.result?.reusedPhoto)) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Zdjęcia tego pakietu nie są gotowe.');
    const [sourceJob] = await tx.select().from(aiJobs).where(eq(aiJobs.id, input.sourceJobId)).for('share');
    const [sourceAsset] = await tx.select().from(aiAssets).where(eq(aiAssets.id, input.sourceAssetId)).for('share');
    const target = recipe.content.recipe.ingredients.find(ingredient => ingredient.id === input.targetId);
    const source = sourceJob?.input.recipe.ingredients.find(ingredient => ingredient.id === sourceJob.targetId);
    if (!sourceJob || !sourceAsset || !target || !source || sourceJob.kind !== 'ingredient' || sourceAsset.kind !== 'ingredient'
      || !['ready', 'applied'].includes(sourceJob.status) || sourceJob.result?.asset?.id !== sourceAsset.id || sourceAsset.jobId !== sourceJob.id
      || sourceAsset.recipeId !== sourceJob.recipeId || sourceAsset.targetId !== sourceJob.targetId
      || !sameLiquidCreamPhotoForm(target, source) || !isOpaqueStudioIngredientProfile(capturedIngredientStyleProfile(sourceJob.input))
      || capturedIngredientStyleProfile(sourceJob.input) !== capturedIngredientStyleProfile(batch.input)) throw new AiError(422, 'INVALID_CORRECTION_SOURCE', 'Źródło musi przedstawiać pasującą płynną śmietankę w stylu tego pakietu.');
    return { scope: { account, batch, recipe, sourceJob, sourceAsset, target, slotIndex, replaced: children.find(job => job.id === input.replacedJobId)! } };
  };
  const preflight = await getDb().transaction(async tx => { await budgetLock(tx); return check(tx); });
  if (preflight.prior) return getPhotoBatch(input.batchId);
  const source = await io.read(preflight.scope!.sourceAsset.blobPathname);
  const metadata = await sharp(source, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
  if (sha(source) !== input.sourceSha256 || metadata.width !== preflight.scope!.sourceAsset.width || metadata.height !== preflight.scope!.sourceAsset.height
    || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1 || metadata.depth !== 'uchar'
    || metadata.hasAlpha && (await sharp(source).extractChannel('alpha').stats()).channels[0].min !== 255) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Sprawdzone zdjęcie musi być kompletną, nieprzezroczystą fotografią o zapisanej tożsamości.');
  await getDb().transaction(async tx => {
    await budgetLock(tx); const checked = await check(tx); if (checked.prior) return;
    const { account, batch, recipe, sourceJob, sourceAsset, target, slotIndex, replaced } = checked.scope!;
    if (sourceAsset.blobPathname !== preflight.scope!.sourceAsset.blobPathname) throw new AiError(409, 'INVALID_CORRECTION_SOURCE', 'Ścieżka sprawdzonego zdjęcia zmieniła się.');
    const profile = capturedIngredientStyleProfile(batch.input), identity = ingredientImageIdentity(target, profile);
    const photo = { src: `/media/${sourceAsset.id}`, columns: 1, rows: 1, index: 0, alt: target.name, caption: sourceAsset.caption, aspectRatio: sourceAsset.width / sourceAsset.height };
    const result: AiResult = { content: null, asset: null, reusedPhoto: { ...photo, styleProfile: profile }, reuse: { source: 'library', key: identity.key },
      notes: ['Wybrano sprawdzone zdjęcie płynnej, nieubitej śmietanki z biblioteki. Zachowano całą fotografię i historię poprzedniego wyniku; bez płatnego zgłoszenia.', input.reviewNote],
      derivation: { method: 'reviewed_ingredient_reuse', sourceJobId: sourceJob.id, sourceAssetId: sourceAsset.id, sha256: input.sourceSha256 } };
    const id = randomUUID(); const captured = structuredClone(recipe.content); captured.aiPhotography = { ingredientStyleProfile: profile };
    await tx.insert(aiJobs).values({ id, photoBatchId: batch.id, recipeId: recipe.id, baseRevision: recipe.revision, kind: 'ingredient', targetId: input.targetId,
      status: 'ready', provider: 'fal', model, brief: input.reviewNote, requestKey: input.requestKey, inputHash, ingredientKey: identity.key,
      input: captured, createdBy: account.id, createdByName: account.name, reservedUsd: '0', chargedUsd: '0', costBasis: 'usage', providerFinishedAt: new Date(), ingredientResolvedAt: new Date(), result });
    await tx.insert(aiLedger).values(['reserve', 'settle'].map(entry => ({ id: randomUUID(), jobId: id, entry: entry as 'reserve' | 'settle', amountUsd: '0', basis: 'not_charged' as const })));
    await tx.insert(ingredientImages).values({ ...identity, assetId: sourceAsset.id, sourceJobId: sourceJob.id, photo, eligibility: 'usable' }).onConflictDoNothing();
    const reusedMatch = /^\/media\/([a-f0-9-]{36})$/.exec(replaced.result?.reusedPhoto?.src ?? '');
    const wrongAsset = replaced.result?.asset?.id ?? reusedMatch?.[1];
    if (wrongAsset && wrongAsset !== sourceAsset.id) await tx.update(ingredientImages).set({ eligibility: 'rejected' }).where(and(eq(ingredientImages.assetId, wrongAsset), eq(ingredientImages.key, identity.key)));
    const slots = structuredClone(batch.slots); slots[slotIndex].jobId = id;
    await tx.update(aiPhotoBatches).set({ slots, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, batch.id));
  });
  return getPhotoBatch(input.batchId);
}
