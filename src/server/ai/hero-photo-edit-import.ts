import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { get, put } from '@vercel/blob';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { AiAsset, AiResult } from '@/lib/ai-types';
import type { EditorialActor } from '@/lib/editorial-types';
import { heroPresentationProfile, isGlassHeroPresentation, resolveHeroPresentation } from '@/lib/hero-presentation';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { requireRecipeContentApproval } from '@/server/editorial/content-approval';
import { getMediaBlob } from '@/server/media/storage';
import { AiError } from './errors';
import { validateGlassHeroCutout, validateSolidHeroCutout } from './photo-format';
import { samePhotoSubject } from './photo-subject';
import { aiAssets, aiJobs, aiLedger } from './schema';
import { budgetLock, getJob, trustedActor, type AiTransaction } from './store';

export const heroPhotoEditModel = 'jesie/reviewed-hero-image-edit-v1';
export type HeroPhotoEditImport = {
  recipeId: string; expectedRevision: number;
  sourceJobId: string; sourceAssetId: string; sourceSha256: string;
  localPath: string; sha256: string; requestKey: string; reviewNote: string;
};
export type HeroPhotoEditImportStorage = {
  read(pathname: string): Promise<Buffer>;
  ensure(pathname: string, bytes: Buffer, sha256: string): Promise<string>;
};
const maximumBytes = 32 * 1024 * 1024;
const maximumPixels = 8_500_000;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function requestHash(input: HeroPhotoEditImport) {
  // Local filenames and retry tokens are not part of the reviewed image identity.
  return sha(Buffer.from(JSON.stringify({ recipeId: input.recipeId, expectedRevision: input.expectedRevision,
    sourceJobId: input.sourceJobId, sourceAssetId: input.sourceAssetId, sourceSha256: input.sourceSha256,
    sha256: input.sha256, reviewNote: input.reviewNote, model: heroPhotoEditModel })));
}

async function bounded(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
    if (size > maximumBytes) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Plik fotografii jest za duży.'); chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

const privateStorage: HeroPhotoEditImportStorage = {
  async read(pathname) {
    const blob = await getMediaBlob(pathname, { useCache: false });
    if (!blob || blob.statusCode !== 200) throw new AiError(503, 'AI_REFERENCE_UNAVAILABLE', 'Nie można odczytać sprawdzonej fotografii źródłowej.');
    return bounded(blob.stream);
  },
  async ensure(pathname, bytes, digest) {
    const existing = async () => {
      const blob = await get(pathname, { access: 'private', useCache: false });
      if (!blob || blob.statusCode !== 200) return false;
      if (sha(await bounded(blob.stream)) !== digest) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Pod tym adresem zapisano inną poprawkę.');
      return true;
    };
    if (await existing()) return pathname;
    try {
      const saved = await put(pathname, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'image/png' });
      if (saved.pathname !== pathname) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Nie potwierdzono adresu poprawki.');
    } catch (error) {
      // Recover an ambiguous upload from its exact bytes, never by overwriting.
      if (!await existing()) throw error;
    }
    return pathname;
  },
};

async function checkedScope(tx: AiTransaction, input: HeroPhotoEditImport, actor: EditorialActor) {
  const account = await trustedActor(tx, actor.id);
  const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, input.recipeId)).for('share');
  if (recipe?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
  if (!recipe || recipe.revision !== input.expectedRevision) throw new AiError(409, 'REVISION_CONFLICT', 'Przepis zmienił się od sprawdzenia fotografii.');
  if (!['draft', 'in_review'].includes(recipe.editorialStatus) || recipe.publicationStatus !== 'never_published'
    || recipe.approvedRevision !== null || recipe.publishedRevision !== null || recipe.publishedId !== null) {
    throw new AiError(409, 'DRAFT_PHOTO_EDIT_SCOPE', 'Poprawka wymaga aktywnego, niepublikowanego szkicu.');
  }
  if (recipe.content.recipe.image !== `/media/${input.sourceAssetId}`) throw new AiError(409, 'PHOTO_REPLACEMENT_CONFLICT', 'Zdjęcie główne zmieniło się od wyboru źródła. Zachowano obie wersje.');
  await requireRecipeContentApproval(tx, recipe);
  const [sourceJob] = await tx.select().from(aiJobs).where(eq(aiJobs.id, input.sourceJobId)).for('share');
  const [sourceAsset] = await tx.select().from(aiAssets).where(eq(aiAssets.id, input.sourceAssetId)).for('share');
  const result = sourceJob?.result?.asset;
  if (!sourceJob || !sourceAsset || sourceJob.kind !== 'hero' || sourceJob.targetId !== null || sourceJob.recipeId !== recipe.id
    || !['ready', 'applied'].includes(sourceJob.status) || !sourceJob.providerFinishedAt || sourceJob.errorCode !== null
    || sourceJob.result?.content !== null || !result || result.id !== sourceAsset.id || result.jobId !== sourceJob.id
    || result.recipeId !== recipe.id || result.kind !== 'hero' || result.targetId !== null || result.src !== `/media/${sourceAsset.id}`
    || result.model !== sourceJob.model || result.width !== sourceAsset.width || result.height !== sourceAsset.height
    || sourceAsset.jobId !== sourceJob.id || sourceAsset.recipeId !== recipe.id || sourceAsset.kind !== 'hero' || sourceAsset.targetId !== null
    || sourceAsset.model !== sourceJob.model || !['image/png', 'image/jpeg', 'image/webp'].includes(sourceAsset.contentType)
    || !samePhotoSubject(sourceJob.input, recipe.content, 'hero', null)) {
    throw new AiError(422, 'INVALID_CORRECTION_SOURCE', 'Wybierz zarejestrowaną, zakończoną fotografię tego dania i zatwierdzonej prezentacji.');
  }
  return { account, recipe, sourceJob, sourceAsset };
}

async function priorImport(tx: AiTransaction, input: HeroPhotoEditImport, actor: EditorialActor, inputHash: string) {
  await trustedActor(tx, actor.id);
  const [prior] = await tx.select().from(aiJobs).where(and(eq(aiJobs.createdBy, actor.id), eq(aiJobs.requestKey, input.requestKey)));
  if (!prior) return null;
  if (prior.inputHash !== inputHash || prior.model !== heroPhotoEditModel || prior.recipeId !== input.recipeId || prior.kind !== 'hero'
    || prior.photoBatchId !== null || !['ready', 'applied'].includes(prior.status) || !prior.result?.asset) {
    throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator został użyty dla innej poprawki.');
  }
  return prior.id;
}

/** Internal ingestion of a visually reviewed built-in edit; ordinary applyJob remains the only draft mutation. */
export async function importHeroPhotoEdit(input: HeroPhotoEditImport, actor: EditorialActor, storage: HeroPhotoEditImportStorage = privateStorage) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.recipeId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || ![input.sourceJobId, input.sourceAssetId].every(id => /^[a-f0-9-]{36}$/i.test(id)) || !isAbsolute(input.localPath)
    || ![input.sha256, input.sourceSha256].every(digest => /^[a-f0-9]{64}$/.test(digest)) || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)
    || !input.reviewNote.trim() || input.reviewNote.length > 1000) throw new AiError(422, 'INVALID_INPUT', 'Uzupełnij dokładny manifest sprawdzonej poprawki.');
  const inputHash = requestHash(input);
  const preflight = await getDb().transaction(async tx => {
    await budgetLock(tx);
    const prior = await priorImport(tx, input, actor, inputHash);
    return prior ? { prior } : { scope: await checkedScope(tx, input, actor) };
  });
  if (preflight.prior) return getJob(preflight.prior);
  const scope = preflight.scope!;
  // Bind to the exact currently displayed source, including its existing alpha.
  // A new image-tool edit is reviewed visually and need not preserve RGB values.
  const source = await storage.read(scope.sourceAsset.blobPathname);
  if (!source.length || source.length > maximumBytes || sha(source) !== input.sourceSha256) throw new AiError(422, 'PHOTO_SOURCE_INVALID', 'Źródło nie odpowiada sprawdzonej fotografii.');
  try {
    const metadata = await sharp(source, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || metadata.width !== scope.sourceAsset.width || metadata.height !== scope.sourceAsset.height
      || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1 || metadata.depth !== 'uchar') throw new Error('Unsupported source');
  } catch { throw new AiError(422, 'PHOTO_SOURCE_INVALID', 'Źródło nie odpowiada zarejestrowanej fotografii.'); }
  const bytes = await readFile(input.localPath);
  if (!bytes.length || bytes.length > maximumBytes || sha(bytes) !== input.sha256) throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Plik poprawki nie odpowiada zatwierdzonemu wynikowi.');
  let size: { width: number; height: number };
  try {
    const metadata = await sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height || Math.min(metadata.width, metadata.height) < 512
      || Math.max(metadata.width, metadata.height) > 4096 || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1 || metadata.depth !== 'uchar') throw new Error('Unsupported image');
    const presentation = resolveHeroPresentation(scope.recipe.content.recipe);
    const checked = await (isGlassHeroPresentation(presentation) ? validateGlassHeroCutout(bytes) : validateSolidHeroCutout(bytes));
    if (checked.foregroundPixels < checked.width * checked.height * 0.01) throw new Error('Invisible subject');
    size = { width: checked.width, height: checked.height };
  } catch {
    throw new AiError(422, 'IMPORTED_IMAGE_INVALID', 'Poprawka musi być przezroczystym plikiem PNG z zachowaną całą potrawą i naczyniem.');
  }
  const pathname = `ai/hero-photo-edit/${input.recipeId}/${inputHash}/${input.sourceAssetId}-${input.sha256}.png`;
  if (await storage.ensure(pathname, bytes, input.sha256) !== pathname) throw new AiError(409, 'IMPORTED_BLOB_CONFLICT', 'Nie potwierdzono adresu poprawki.');
  const id = await getDb().transaction(async tx => {
    await budgetLock(tx);
    const prior = await priorImport(tx, input, actor, inputHash);
    if (prior) return prior;
    const { account, recipe, sourceJob, sourceAsset } = await checkedScope(tx, input, actor);
    if (sourceAsset.blobPathname !== scope.sourceAsset.blobPathname) throw new AiError(409, 'INVALID_CORRECTION_SOURCE', 'Ścieżka sprawdzonego źródła zmieniła się.');
    const id = randomUUID(), now = new Date(), captured = structuredClone(recipe.content), alt = structuredClone(recipe.content.recipe.imageAlt);
    captured.aiPhotography = { heroStyleProfile: heroPresentationProfile };
    const asset: AiAsset = { id, jobId: id, recipeId: recipe.id, kind: 'hero', targetId: null, src: `/media/${id}`, ...size,
      model: heroPhotoEditModel, alt, caption: sourceAsset.caption, styleProfile: heroPresentationProfile, createdAt: now.toISOString() };
    const result: AiResult = { content: null, asset,
      notes: ['Sprawdzona poprawka tła zachowanej fotografii wbudowanym narzędziem edycji obrazu. Import bez nowego żądania płatnego API aplikacji.', input.reviewNote],
      derivation: { method: 'builtin_hero_background_edit', sourceJobId: sourceJob.id, sourceAssetId: sourceAsset.id, sha256: input.sha256, sourceSha256: input.sourceSha256 } };
    await tx.insert(aiJobs).values({ id, recipeId: recipe.id, baseRevision: recipe.revision, kind: 'hero', targetId: null, status: 'ready', provider: 'openai', model: heroPhotoEditModel,
      brief: input.reviewNote, requestKey: input.requestKey, inputHash, input: captured, createdBy: account.id, createdByName: account.name,
      reservedUsd: '0', chargedUsd: '0', costBasis: 'usage', providerFinishedAt: now, result });
    await tx.insert(aiAssets).values({ id, jobId: id, recipeId: recipe.id, kind: 'hero', targetId: null, blobPathname: pathname, originalBlobPathname: pathname,
      ...size, contentType: 'image/png', alt, caption: sourceAsset.caption, model: heroPhotoEditModel });
    await tx.insert(aiLedger).values(['reserve', 'settle'].map(entry => ({ id: randomUUID(), jobId: id, entry: entry as 'reserve' | 'settle', amountUsd: '0', basis: 'not_charged' as const })));
    return id;
  });
  return getJob(id);
}
