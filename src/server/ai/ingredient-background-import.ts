import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { get, put } from '@vercel/blob';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import type { AiAsset, AiResult } from '@/lib/ai-types';
import type { EditorialActor } from '@/lib/editorial-types';
import type { MediaTile } from '@/lib/recipe-media';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { AiError } from './errors';
import { capturedIngredientStyleProfile, ingredientImageIdentity, ingredientStudioBackgroundHex, paperIngredientStyleProfile, whiteIngredientStyleProfile } from './ingredient-profile';
import { registerIngredientImage } from './ingredient-reuse';
import { getPhotoBatch } from './photo-batch';
import { samePhotoSubject } from './photo-subject';
import { aiAssets, aiJobs, aiLedger, aiPhotoBatches, type StoredPhotoBatchSlot } from './schema';
import { budgetLock, trustedActor, type AiTransaction } from './store';

export const ingredientBackgroundEditModel = 'jesie/ingredient-paper-background-v3';
export type IngredientBackgroundImportEntry = {
  targetId: string;
  sourceJobId: string;
  sourceAssetId: string;
  localPath: string;
  sha256: string;
  expectedPhoto: MediaTile | null;
};
export type IngredientBackgroundImport = {
  recipeId: string;
  expectedRevision: number;
  requestKey: string;
  entries: IngredientBackgroundImportEntry[];
};
type ImportedImage = { bytes: Buffer; width: number; height: number; pathname: string };
export type IngredientBackgroundImportStorage = { ensure(pathname: string, bytes: Buffer, sha256: string): Promise<string> };
const maximumBytes = 32 * 1024 * 1024;
const maximumPixels = 4096 * 4096;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function requestHash(input: IngredientBackgroundImport) {
  return createHash('sha256').update(JSON.stringify({ recipeId: input.recipeId, revision: input.expectedRevision,
    profile: paperIngredientStyleProfile, entries: [...input.entries].sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map(({ targetId, sourceJobId, sourceAssetId, sha256, expectedPhoto }) => ({ targetId, sourceJobId, sourceAssetId, sha256, expectedPhoto })) })).digest('hex');
}

async function boundedBlobBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Plik poprawionej fotografii jest za duży.');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

const privateStorage: IngredientBackgroundImportStorage = {
  async ensure(pathname, bytes, sha256) {
    const existing = async () => {
      const found = await get(pathname, { access: 'private', useCache: false });
      if (!found || found.statusCode !== 200) return false;
      if (hash(await boundedBlobBytes(found.stream)) !== sha256) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Zapisany plik ma inny wynik poprawki. Zachowano istniejącą wersję.');
      return true;
    };
    if (await existing()) return pathname;
    try {
      const saved = await put(pathname, bytes, { access: 'private', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: false });
      if (saved.pathname !== pathname) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Nie potwierdzono tożsamości zapisanego pliku.');
    } catch (error) {
      // A lost upload response is recovered by its stable exact-byte identity.
      // This path never invokes an image model or overwrites an old photograph.
      if (!await existing()) throw error;
    }
    return pathname;
  },
};

async function inspectImage(entry: IngredientBackgroundImportEntry, input: IngredientBackgroundImport, inputHash: string): Promise<ImportedImage> {
  const bytes = await readFile(entry.localPath);
  if (!bytes.length || bytes.length > maximumBytes || hash(bytes) !== entry.sha256) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Plik poprawki nie odpowiada zatwierdzonemu wynikowi.');
  try {
    const image = sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height || metadata.width !== metadata.height || metadata.width < 512 || metadata.width > 4096 || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1 || metadata.depth !== 'uchar') throw new Error('Unsupported image');
    if (metadata.hasAlpha && (await image.extractChannel('alpha').stats()).channels[0].min !== 255) throw new Error('Transparent image');
    // Sharp only inspects metadata and opacity. Upload the original tool bytes;
    // background editing and colour decisions belong to the image editing tool.
    return { bytes, width: metadata.width, height: metadata.height,
      pathname: `ai/ingredient-background/${input.recipeId}/${inputHash}/${entry.sourceAssetId}-${entry.sha256}.png` };
  } catch {
    throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Poprawka musi być pełnym, nieprzezroczystym plikiem PNG.');
  }
}

async function validatedSources(tx: AiTransaction, input: IngredientBackgroundImport, actor: EditorialActor) {
  const account = await trustedActor(tx, actor.id);
  const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, input.recipeId)).for('share');
  if (recipe?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
  if (!recipe || recipe.revision !== input.expectedRevision) throw new AiError(409, 'REVISION_CONFLICT', 'Przepis zmienił się od przygotowania poprawki.');
  if (recipe.editorialStatus === 'archived') throw new AiError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');
  const sources = [];
  for (const entry of input.entries) {
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, entry.sourceJobId)).for('share');
    const [asset] = await tx.select().from(aiAssets).where(eq(aiAssets.id, entry.sourceAssetId)).for('share');
    if (!job || !asset || job.kind !== 'ingredient' || job.recipeId !== recipe.id || job.targetId !== entry.targetId || !['ready', 'applied'].includes(job.status)
      || capturedIngredientStyleProfile(job.input) !== whiteIngredientStyleProfile || job.result?.asset?.id !== asset.id || asset.jobId !== job.id
      || asset.recipeId !== recipe.id || asset.kind !== 'ingredient' || asset.targetId !== entry.targetId || !samePhotoSubject(job.input, recipe.content, 'ingredient', entry.targetId)) {
      throw new AiError(422, 'INVALID_CORRECTION_SOURCE', 'Poprawka musi pochodzić z zakończonego zdjęcia tego składnika na białym tle.');
    }
    if (!isDeepStrictEqual(recipe.content.photos.ingredients[entry.targetId] ?? null, entry.expectedPhoto)) throw new AiError(409, 'PHOTO_REPLACEMENT_CONFLICT', 'Zdjęcie składnika zmieniło się od wyboru źródła. Zachowano obie wersje.');
    sources.push({ entry, job, asset });
  }
  return { account, recipe, sources };
}

/** Internal operator-only ingestion of reviewed built-in image edits. No public upload API or paid provider submission. */
export async function importIngredientBackgroundEdits(input: IngredientBackgroundImport, actor: EditorialActor,
  storage: IngredientBackgroundImportStorage = privateStorage) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.recipeId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey) || !input.entries.length || input.entries.length > 100 || new Set(input.entries.map(entry => entry.targetId)).size !== input.entries.length
    || input.entries.some(entry => !/^[A-Za-z0-9_-]{1,100}$/.test(entry.targetId) || !/^[a-f0-9-]{36}$/i.test(entry.sourceJobId) || !/^[a-f0-9-]{36}$/i.test(entry.sourceAssetId) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !isAbsolute(entry.localPath))) {
    throw new AiError(422, 'INVALID_INPUT', 'Wybierz poprawny manifest zatwierdzonych plików i źródeł.');
  }
  const inputHash = requestHash(input);
  const preflight = await getDb().transaction(async tx => {
    await trustedActor(tx, actor.id);
    const [currentRecipe] = await tx.select({ deletedAt: editorialRecipes.deletedAt }).from(editorialRecipes).where(eq(editorialRecipes.id, input.recipeId));
    if (currentRecipe?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
    const [existing] = await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.createdBy, actor.id), eq(aiPhotoBatches.requestKey, input.requestKey)));
    if (existing) {
      if (existing.inputHash !== inputHash) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator został użyty dla innej poprawki.');
      return existing.id;
    }
    const [identical] = await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.recipeId, input.recipeId), eq(aiPhotoBatches.inputHash, inputHash))).limit(1);
    if (identical) return identical.id;
    await validatedSources(tx, input, actor); return null;
  });
  if (preflight) return getPhotoBatch(preflight);
  const images: ImportedImage[] = [];
  for (const entry of input.entries) images.push(await inspectImage(entry, input, inputHash));
  for (let index = 0; index < images.length; index++) images[index].pathname = await storage.ensure(images[index].pathname, images[index].bytes, input.entries[index].sha256);
  const batchId = await getDb().transaction(async tx => {
    await budgetLock(tx);
    const [currentRecipe] = await tx.select({ deletedAt: editorialRecipes.deletedAt }).from(editorialRecipes).where(eq(editorialRecipes.id, input.recipeId));
    if (currentRecipe?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
    const [existing] = await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.createdBy, actor.id), eq(aiPhotoBatches.requestKey, input.requestKey)));
    if (existing) {
      await trustedActor(tx, actor.id);
      if (existing.inputHash !== inputHash) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator został użyty dla innej poprawki.');
      return existing.id;
    }
    const [identical] = await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.recipeId, input.recipeId), eq(aiPhotoBatches.inputHash, inputHash))).limit(1);
    if (identical) { await trustedActor(tx, actor.id); return identical.id; }
    const { account, recipe, sources } = await validatedSources(tx, input, actor);
    const captured = structuredClone(recipe.content);
    captured.aiPhotography = { ingredientStyleProfile: paperIngredientStyleProfile, photoBatchMode: 'ingredients-paper' };
    const id = randomUUID();
    const slots: StoredPhotoBatchSlot[] = input.entries.map(entry => ({ kind: 'ingredient', targetId: entry.targetId,
      label: recipe.content.recipe.ingredients.find(item => item.id === entry.targetId)!.name.pl, jobId: null, replacePhoto: structuredClone(entry.expectedPhoto) }));
    const carry = await tx.select().from(aiJobs).where(and(eq(aiJobs.recipeId, recipe.id), isNull(aiJobs.trendRunId), inArray(aiJobs.status, ['ready', 'applied']))).orderBy(desc(aiJobs.createdAt));
    for (const kind of ['hero', 'step'] as const) {
      const targets = kind === 'hero' ? [null] : recipe.content.recipe.steps.map(step => step.id);
      for (const targetId of targets) {
        if (kind === 'hero' ? recipe.content.recipe.image.trim() : recipe.content.photos.steps[targetId!]?.src) continue;
        const job = carry.find(job => job.kind === kind && job.targetId === targetId && job.result?.asset && samePhotoSubject(job.input, recipe.content, kind, targetId));
        if (job) slots.push({ kind, targetId, label: kind === 'hero' ? 'Zdjęcie główne' : recipe.content.recipe.steps.find(step => step.id === targetId)!.title.pl, jobId: job.id });
      }
    }
    await tx.insert(aiPhotoBatches).values({ id, recipeId: recipe.id, baseRevision: recipe.revision, input: captured, inputHash, slots, status: 'ready', requestKey: input.requestKey,
      createdBy: account.id, createdByName: account.name, reservedUsd: '0', remainingReservedUsd: '0' });
    for (let index = 0; index < sources.length; index++) {
      const { entry, job: source, asset: oldAsset } = sources[index]; const image = images[index]; const jobId = randomUUID();
      const jobInput = structuredClone(captured);
      jobInput.aiPhotography!.ingredientEditSource = { sourceJobId: source.id, sourceAssetId: oldAsset.id, sha256: entry.sha256,
        oldSourceBlobPath: oldAsset.blobPathname, oldOriginalBlobPath: oldAsset.originalBlobPathname };
      const identity = ingredientImageIdentity(jobInput.recipe.ingredients.find(item => item.id === entry.targetId)!, paperIngredientStyleProfile);
      const resultAsset: AiAsset = { id: jobId, jobId, recipeId: recipe.id, kind: 'ingredient', targetId: entry.targetId,
        src: `/media/${jobId}`, width: image.width, height: image.height, alt: oldAsset.alt, caption: oldAsset.caption,
        model: ingredientBackgroundEditModel, styleProfile: paperIngredientStyleProfile, createdAt: new Date().toISOString() };
      const result: AiResult = { content: null, asset: resultAsset, notes: [`Poprawiono tło wbudowanym narzędziem edycji obrazu na kolor serwisu ${ingredientStudioBackgroundHex}. Import bez nowego żądania płatnego API aplikacji.`],
        derivation: { method: 'builtin_image_background_edit', sourceJobId: source.id, sourceAssetId: oldAsset.id, sha256: entry.sha256 } };
      const [job] = await tx.insert(aiJobs).values({ id: jobId, photoBatchId: id, recipeId: recipe.id, baseRevision: recipe.revision, kind: 'ingredient', targetId: entry.targetId,
        status: 'ready', provider: 'openai', model: ingredientBackgroundEditModel, brief: `Poprawienie wyłącznie tła na ${ingredientStudioBackgroundHex} przez wbudowaną edycję obrazu.`,
        requestKey: `ingredient_paper_edit_${id}_${index}`, inputHash: hash(Buffer.from(`${inputHash}:${entry.targetId}`)), input: jobInput,
        ingredientKey: identity.key, createdBy: account.id, createdByName: account.name, reservedUsd: '0', chargedUsd: '0', costBasis: 'usage',
        providerFinishedAt: new Date(), ingredientResolvedAt: new Date(), result }).returning();
      const [asset] = await tx.insert(aiAssets).values({ id: jobId, jobId, recipeId: recipe.id, kind: 'ingredient', targetId: entry.targetId,
        blobPathname: image.pathname, originalBlobPathname: image.pathname, width: image.width, height: image.height, contentType: 'image/png',
        alt: oldAsset.alt, caption: oldAsset.caption, model: ingredientBackgroundEditModel }).returning();
      await tx.insert(aiLedger).values(['reserve', 'settle'].map(entry => ({ id: randomUUID(), jobId, entry: entry as 'reserve' | 'settle', amountUsd: '0', basis: 'not_charged' as const })));
      await registerIngredientImage(tx, job, asset, { hasTransparency: false, styleProfile: paperIngredientStyleProfile });
      slots[index].jobId = jobId;
    }
    await tx.update(aiPhotoBatches).set({ slots }).where(eq(aiPhotoBatches.id, id));
    return id;
  });
  return getPhotoBatch(batchId);
}
