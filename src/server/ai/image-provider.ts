import 'server-only';
import { createFalClient } from '@fal-ai/client';
import { get, put } from '@vercel/blob';
import sharp, { type Metadata } from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import { z } from 'zod';
import type { AiKind } from '@/lib/ai-types';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes, type Ingredient } from '@/lib/recipes';
import { stepPhotoCaption } from '@/lib/recipe-presentation';
import { getAssetForExecution, getJobForExecution } from './store';
import { ProviderError } from './provider-error';
import { ConfirmedRateLimitError, confirmedFalRateLimit, retryConfirmedRateLimit } from './submission-rate-limit';
import { applyHeroMask, cropStepPhoto, fillCookwareInterior, fillEnclosedCutout, fillSauceboatInterior, validateCutout, validateVisiblePhoto, validateSolidHeroCutout, validateGlassHeroCutout, PhotoFormatError } from './photo-format';
import { heroCutoutModel, heroMaskPromptVersion, glassHeroMaskPromptVersion, approvedImageModel, failedHeroSourcePrefix, isRecoverablePhotoSource, type CutoutKind, type FailedHeroSource } from './image-actions';
import { capturedIngredientStyleProfile, ingredientStudioBackgroundHex, isOpaqueStudioIngredientProfile, paperIngredientStyleProfile } from './ingredient-profile';
import type { MediaTile } from '@/lib/recipe-media';
import { isGlassHeroPresentation } from '../../lib/hero-presentation';
import { capturedHeroProfile, capturedHeroPresentation, imageBrief } from './image-prompt';
import { normalizeGeneratedHeroAlpha } from './generated-hero-alpha';
import { rankHeroMaskCandidates, selectHeroMaskCandidate } from './hero-mask-candidates';
import { staticIngredientPhotoPaths } from '@/lib/static-ingredient-photos';
import { curatedRecipePhotoPaths } from '@/lib/curated-recipe-photos';
export { imageBrief } from './image-prompt';
import { compactPhoto, losslessPhoto } from './compact-photo';
import { findRetainedPhotoSource } from './retained-photo-source';
import { getMediaBlob } from '@/server/media/storage';
import { readProviderBackup } from './provider-backup';
import { createPrivatePhotoBody } from './photo-blob-body';
import { withPhotoReadStage, photoReadDiagnostic, photoReadRedirectBlocked, type PhotoReadStage, type PhotoReadDiagnostic } from './photo-read-diagnostic';

const approvedModel = approvedImageModel;
const heroSources = new Set(recipes.map(recipe => recipe.image));
const staticSources = new Set([...heroSources, ...staticIngredientPhotoPaths, ...curatedRecipePhotoPaths, ...recipes.map(recipe => `/images/steps-${recipe.id}.webp`)]);
const cdnHosts = new Set(['fal.media', 'v3.fal.media', 'v3b.fal.media']);
const maxImageBytes = 32 * 1024 * 1024;
const resultSchema = z.object({ images: z.array(z.object({ url: z.string(), content_type: z.string().optional() })).min(1).max(1) });

function selectedMaskUrl(data: unknown) {
  return rankHeroMaskCandidates(data)[0].url;
}

function hasCookwareHandles(presentation: ReturnType<typeof capturedHeroPresentation>) {
  return presentation !== null && ['clay-pot', 'pot', 'pan', 'baking-dish'].includes(presentation.container);
}

function preservesHeroApertures(input: EditorialContent) {
  const presentation = capturedHeroPresentation(input);
  return isGlassHeroPresentation(presentation) || presentation?.container === 'sauceboat' || hasCookwareHandles(presentation);
}

export function heroMaskPrompt(input: EditorialContent) {
  const presentation = capturedHeroPresentation(input);
  if (input.aiPhotography?.heroMaskPromptVersion === glassHeroMaskPromptVersion && presentation?.container === 'glass') {
    return 'drinking glass with all its food contents';
  }
  if (input.aiPhotography?.heroMaskPromptVersion === heroMaskPromptVersion) {
    // SAM concept prompts name one object with a short noun phrase. Rim, food
    // retention and handle gaps are checked locally rather than described to SAM.
    const concepts = { plate: 'plate', bowl: 'bowl', sauceboat: 'sauce boat', jar: 'jar', bottle: 'bottle', glass: 'drinking glass', 'clay-pot': 'clay pot', pot: 'pot', pan: 'pan', 'baking-dish': 'baking dish', platter: 'platter' };
    return presentation ? concepts[presentation.container] : 'serving dish';
  }
  if (!presentation) return 'the entire ceramic bowl or plate including its complete rim and all the food inside';
  const vessels = { plate: 'ceramic plate', bowl: 'ceramic bowl', sauceboat: 'ceramic sauce boat including its handle and spout', jar: 'glass jar including its complete body, rim and visible lid or closure', bottle: 'glass bottle including its complete body, neck and visible cork, stopper or closure', glass: 'drinking glass or goblet including its complete open rim, body, stem and foot when present', 'clay-pot': 'earthenware clay cooking pot including its complete body, rim and handles', pot: 'cooking pot including its complete body, rim and handles', pan: 'frying pan or skillet including its complete rim and handle', 'baking-dish': 'ovenproof baking dish including its complete rim and handles', platter: 'serving platter including its complete rim' };
  return `the entire ${vessels[presentation.container]} and all its finished food contents, preserving the complete vessel outline${presentation.container === 'sauceboat' ? ', excluding the background visible through the open gap inside its handle' : hasCookwareHandles(presentation) ? ', excluding the background visible through any open gap inside its handles' : ''}`;
}

function key() { return process.env.FAL_KEY || process.env.FAL_API_KEY; }
function client() {
  if (!key()) throw new ProviderError('AI_CONFIGURATION_REQUIRED', 'Podłącz usługę zdjęć przed ich tworzeniem.');
  return createFalClient({ credentials: key(), retry: { maxRetries: 0 },
    fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000), redirect: 'error' }) });
}

export function approvedFalUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProviderError('AI_IMAGE_URL_INVALID', 'Dostawca zwrócił nieobsługiwany adres obrazu.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !cdnHosts.has(url.hostname)) throw new ProviderError('AI_IMAGE_URL_INVALID', 'Dostawca zwrócił nieobsługiwany adres obrazu.');
  return url;
}

export async function readBounded(stream: ReadableStream<Uint8Array> | null, maximum = maxImageBytes) {
  if (!stream) throw new ProviderError('AI_IMAGE_EMPTY', 'Dostawca nie zwrócił pliku obrazu.');
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new ProviderError('AI_IMAGE_TOO_LARGE', 'Plik obrazu przekracza dopuszczalny rozmiar.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

async function readSourceImage(src: string, recipeId?: string, kind: CutoutKind = 'hero', targetId: string | null = null, ingredient?: Ingredient) {
  if (src.startsWith(failedHeroSourcePrefix)) {
    const id = src.slice(failedHeroSourcePrefix.length);
    if (!recipeId || !/^[a-f0-9-]{36}$/i.test(id)) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nieprawidłowe źródło zakończonej fotografii.');
    const source = await getJobForExecution(id);
    return recoverFailedPhoto(source, recipeId, kind, targetId, ingredient);
  }
  if (staticSources.has(src)) return readFile(resolve(process.cwd(), `public${src}`));
  const match = /^\/media\/([a-f0-9-]{36})$/.exec(src);
  const asset = match ? await getAssetForExecution(match[1]) : null;
  if (!asset) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono istniejącej fotografii.');
  // Original generations have a lossless source. Derived corrections must use
  // their current web image: their archived original may still contain the background.
  const pathname = asset.model === approvedModel && asset.originalBlobPathname ? asset.originalBlobPathname : asset.blobPathname;
  const blob = await getMediaBlob(pathname, { useCache: false });
  if (!blob || blob.statusCode !== 200) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie udało się odczytać istniejącej fotografii.');
  return readBounded(blob.stream);
}

async function referenceImage(input: EditorialContent) {
  const src = input.recipe.image;
  if (!src) return null;
  const bytes = await readSourceImage(src);
  const compressed = await sharp(bytes, { limitInputPixels: 8_500_000 }).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const url = await client().storage.upload(new Blob([new Uint8Array(compressed)], { type: 'image/png' }), { lifecycle: { expiresIn: '1d' } });
  return approvedFalUrl(url).href;
}

export function imageSize(kind: Exclude<AiKind, 'recipe'>) {
  return kind === 'hero' ? { width: 2560, height: 1920 } : kind === 'ingredient' ? { width: 1024, height: 1024 } : { width: 2240, height: 960 };
}

export function ingredientMaskPrompt(ingredient: Ingredient | undefined) {
  return ingredient && (/^spirytus$/i.test(ingredient.name.pl.trim()) || /\brectified spirit\b/i.test(ingredient.name.en))
    ? 'bowl' : ingredient?.name.en.trim() || ingredient?.name.pl.trim() || 'ingredient';
}

async function cutoutInput(input: EditorialContent, kind: CutoutKind, targetId: string | null) {
  const ingredient = kind === 'ingredient' ? input.recipe.ingredients.find(item => item.id === targetId) : undefined;
  const prompt = kind === 'hero' ? heroMaskPrompt(input) : ingredientMaskPrompt(ingredient);
  const src = kind === 'hero' ? input.recipe.image : targetId && ingredient ? input.photos.ingredients[targetId]?.src : undefined;
  if (!src || kind === 'ingredient' && !src.startsWith(failedHeroSourcePrefix)) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono zakończonej fotografii do wycięcia.');
  const bytes = await readSourceImage(src, input.recipe.id, kind, targetId, ingredient);
  await validateHeroCutoutSource(bytes, src.startsWith(failedHeroSourcePrefix));
  const png = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).png().toBuffer();
  const imageUrl = approvedFalUrl(await client().storage.upload(new Blob([new Uint8Array(png)], { type: 'image/png' }), { lifecycle: { expiresIn: '1d' } })).href;
  return { image_url: imageUrl, prompt,
    apply_mask: false, return_multiple_masks: true, max_masks: 3, include_scores: true, include_boxes: true,
    output_format: 'png', sync_mode: false };
}

export async function validateHeroCutoutSource(bytes: Buffer, recoveringFailedResult = false) {
  if (recoveringFailedResult) {
    try { await validateCutout(bytes); }
    catch (error) {
      if (error instanceof PhotoFormatError && error.code === 'PHOTO_CUTOUT_INVALID') return;
      throw error;
    }
    throw new ProviderError('AI_ALREADY_HAS_CUTOUT', 'Gotowe zdjęcie ma już poprawne wycięcie. Nie wysłano kolejnego płatnego zlecenia.');
  }
  const source = sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' });
  if ((await source.metadata()).hasAlpha && (await source.stats()).channels.at(-1)?.min !== 255) {
    throw new ProviderError('AI_ALREADY_HAS_CUTOUT', 'Zdjęcie zawiera już przezroczystość. Sprawdź istniejące wycięcie przed zleceniem kolejnej korekty.');
  }
}

async function checkedPhotoFormat<T>(format: () => Promise<T>) {
  try { return await format(); }
  catch (error) {
    if (error instanceof PhotoFormatError) throw new ProviderError('AI_IMAGE_INVALID', error.message);
    throw error;
  }
}

export async function submitImage(model: string, kind: Exclude<AiKind, 'recipe'>, input: EditorialContent, targetId: string | null, brief: string, beforeSubmit?: () => Promise<void>) {
  if (model !== approvedModel && model !== heroCutoutModel) throw new ProviderError('AI_MODEL_NOT_APPROVED', 'Ten model nie ma zatwierdzonego profilu fotografii i kosztów.');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new ProviderError('AI_CONFIGURATION_REQUIRED', 'Magazyn fotografii jest niepodłączony.');
  if (model === heroCutoutModel && kind !== 'hero' && kind !== 'ingredient') throw new ProviderError('AI_TARGET_MISSING', 'Wycinanie tła dotyczy zdjęcia dania lub składnika.');
  const ingredientProfile = capturedIngredientStyleProfile(input);
  const studioIngredient = kind === 'ingredient' && isOpaqueStudioIngredientProfile(ingredientProfile);
  if (model === heroCutoutModel && studioIngredient) throw new ProviderError('AI_ACTION_NOT_SUPPORTED', ingredientProfile === paperIngredientStyleProfile
    ? 'Fotografia składnika na tle serwisu zachowuje naturalny cień i nie wymaga wycinania tła.'
    : 'Fotografia składnika na białym tle zachowuje naturalny cień i nie wymaga wycinania tła.');
  let endpoint = model;
  let body: object;
  if (model === heroCutoutModel) {
    try { body = await cutoutInput(input, kind as CutoutKind, targetId); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie udało się przygotować obecnego zdjęcia do wycięcia. Nie wysłano płatnego zlecenia.');
    }
  }
  else {
    const prompt = imageBrief(kind, input, targetId, brief);
    let reference: string | null;
    // An edit reference strongly preserves the plated finished state even when
    // prose calls it style-only. Step lessons follow their captured method;
    // shared lighting is specified in the prompt without copying the hero.
    try { reference = kind === 'hero' || kind === 'step' || studioIngredient ? null : await referenceImage(input); }
    catch { throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie udało się przygotować referencji stylu. Sprawdź główną fotografię.'); }
    endpoint = reference ? model.replace('/text-to-image', '/edit') : model;
    body = { prompt, image_size: imageSize(kind), quality: kind === 'hero' ? 'xhigh' : 'high', num_images: 1,
      background: kind === 'step' || studioIngredient ? 'opaque' : 'transparent', output_format: 'png', sync_mode: false,
      ...(reference ? { image_urls: [reference] } : {}) };
  }
  const credential = key();
  if (!credential) throw new ProviderError('AI_CONFIGURATION_REQUIRED', 'Podłącz usługę zdjęć przed ich tworzeniem.');
  return retryConfirmedRateLimit(async () => { try {
    // The SDK's queue submit retries override its global retry configuration.
    // Submit directly; only an explicit rate-limit rejection permits a retry.
    const response = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST', signal: AbortSignal.timeout(30_000), redirect: 'error',
      headers: { Authorization: `Key ${credential}`, 'Content-Type': 'application/json',
        'X-Fal-No-Retry': '1', 'x-app-fal-disable-fallback': 'true',
        'x-fal-request-timeout': '300', 'x-fal-queue-priority': 'normal',
        'x-fal-object-lifecycle-preference': JSON.stringify({ expiration_duration_seconds: 86400 }) },
      body: JSON.stringify(body),
    });
    const rateLimit = await confirmedFalRateLimit(response);
    if (rateLimit) throw rateLimit;
    if ([400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(response.status)) throw new ProviderError('AI_PROVIDER_REJECTED', 'Usługa zdjęć odrzuciła zlecenie. Sprawdź dostęp, saldo i limit konta.');
    if (!response.ok) throw new ProviderError('AI_SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zlecenia przez usługę zdjęć. Koszt pozostaje nieznany; ponowne wysłanie jest zablokowane.', true);
    const acknowledgement = await response.json() as { request_id?: string };
    if (typeof acknowledgement.request_id !== 'string' || !acknowledgement.request_id) throw new ProviderError('AI_SUBMISSION_UNCERTAIN', 'Usługa zdjęć nie potwierdziła identyfikatora zlecenia.', true);
    return acknowledgement.request_id;
  } catch (error) {
    if (error instanceof ConfirmedRateLimitError) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('AI_SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zlecenia przez usługę zdjęć. Koszt pozostaje nieznany; ponowne wysłanie jest zablokowane.', true);
  } }, beforeSubmit);
}

export async function imageBill(requestId: string) {
  const credential = process.env.FAL_BILLING_KEY || key();
  if (!credential) return null;
  try {
    const url = new URL('https://api.fal.ai/v1/models/billing-events'); url.searchParams.set('request_id', requestId); url.searchParams.set('limit', '50');
    const response = await fetch(url, { headers: { Authorization: `Key ${credential}` }, signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json() as { billing_events?: { request_id: string; cost_total: number | null; cost_estimate_nano_usd?: number | null }[]; has_more?: boolean };
    if (data.has_more) return null;
    const events = data.billing_events?.filter(event => event.request_id === requestId);
    if (!events?.length || events.some(event => event.cost_total === null || !Number.isFinite(event.cost_total) || event.cost_total < 0)) return null;
    const cost = events.reduce((sum, event) => sum.add(event.cost_total!), new Decimal(0));
    return { chargedUsd: cost.toFixed(8, Decimal.ROUND_CEIL), costBasis: 'usage' as const };
  } catch { return null; }
}

async function putOnce(pathname: string, bytes: Buffer, contentType: string, diagnostic?: { jobId: string; requestId: string; variant: 'archive' | 'web' }) {
  const observe = <T>(stage: PhotoReadStage, operation: () => T | Promise<T>) => diagnostic
    ? withPhotoReadStage({ jobId: diagnostic.jobId, requestId: diagnostic.requestId, stage }, operation)
    : operation();
  // A pre-upload existence check must not cache a missing file at the CDN.
  const existing = await observe(diagnostic?.variant === 'web' ? 'photo-web-read' : 'photo-archive-read', () => get(pathname, { access: 'private', useCache: false }));
  if (existing?.statusCode === 200) {
    const saved = await readBounded(existing.stream);
    if (createHash('sha256').update(saved).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) throw new ProviderError('AI_ASSET_CONFLICT', 'Istniejący plik generacji różni się od wyniku. Zachowano jego poprzednią wersję.');
    return;
  }
  // A standard immutable Blob preserves the exact binary bytes and gives the
  // storage client a repeatable body across runtimes and safe transport retries.
  const body = createPrivatePhotoBody(bytes, contentType);
  await observe(diagnostic?.variant === 'web' ? 'photo-web-upload' : 'photo-archive-upload', () => put(pathname, body, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType }));
}

async function downloadImage(value: string, context: 'accepted' | 'reference' = 'accepted', inspectStatus?: (status: number) => void) {
  const response = await fetch(approvedFalUrl(value), { signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' });
  inspectStatus?.(response.status);
  if (!response.ok) {
    // A failed reference download happens before the new request is sent.
    // Only an accepted job's own result needs an uncertain receipt read.
    if (context === 'reference') throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie udało się pobrać istniejącego zdjęcia do korekty. Nie wysłano płatnego zlecenia.');
    throw new ProviderError('AI_IMAGE_DOWNLOAD_UNAVAILABLE', 'Zakończone zdjęcie nie jest obecnie dostępne do pobrania. Zachowano identyfikator zlecenia; kontynuacja ponowi odczyt tego wyniku.', true);
  }
  if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new ProviderError('AI_IMAGE_INVALID', 'Wynik nie jest obsługiwanym plikiem fotograficznym.');
  if (Number(response.headers.get('content-length') ?? 0) > maxImageBytes) throw new ProviderError('AI_IMAGE_TOO_LARGE', 'Obraz przekracza dopuszczalny rozmiar.');
  return readBounded(response.body);
}

async function acceptedMaskContentType(bytes: Buffer) {
  let metadata: Metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata(); }
  catch { throw new ProviderError('AI_IMAGE_INVALID', 'Nie udało się odczytać maski wycięcia.'); }
  if (!bytes.length || bytes.length > maxImageBytes || !metadata.width || !metadata.height || metadata.width * metadata.height > 8_500_000
    || (metadata.pages ?? 1) !== 1 || metadata.depth !== 'uchar' || (metadata.orientation ?? 1) !== 1 || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) {
    throw new ProviderError('AI_IMAGE_INVALID', 'Maska ma nieprawidłowy format lub wymiary.');
  }
  return `image/${metadata.format}`;
}

// The accepted receipt is immutable on its job. Keep its exact selected mask
// before geometry checks, so a local correction never needs another paid mask.
async function readMaskArchive(pathname: string) {
  const blob = await get(pathname, { access: 'private', useCache: false });
  if (!blob || blob.statusCode !== 200) return null;
  const bytes = await readBounded(blob.stream);
  await acceptedMaskContentType(bytes);
  return bytes;
}

async function readAcceptedMask(jobId: string) {
  return await readMaskArchive(`ai/${jobId}/accepted-mask-v2`) ?? await readMaskArchive(`ai/${jobId}/accepted-mask-v1`);
}

async function readMaskManifest(jobId: string) {
  const blob = await get(`ai/${jobId}/accepted-mask-candidates-v1.json`, { access: 'private', useCache: false });
  if (!blob || blob.statusCode !== 200) return null;
  const data: unknown = JSON.parse((await readBounded(blob.stream, 32 * 1024)).toString('utf8'));
  rankHeroMaskCandidates(data).forEach(candidate => approvedFalUrl(candidate.url));
  return data;
}

type HeroRecoveryStorage = { read: (pathname: string) => Promise<Buffer | null>; write: (pathname: string, bytes: Buffer) => Promise<void>;
  retained?: (source: FailedHeroSource, kind: CutoutKind, targetId: string | null) => Promise<string | null> };
const heroRecoveryStorage: HeroRecoveryStorage = {
  async read(pathname) {
    const blob = await getMediaBlob(pathname, { useCache: false });
    if (!blob) return null;
    if (blob.statusCode !== 200) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie udało się odczytać zachowanego zdjęcia.');
    return readBounded(blob.stream);
  },
  write: (pathname, bytes) => putOnce(pathname, bytes, pathname.endsWith('.webp') ? 'image/webp' : 'image/png'),
  retained: findRetainedPhotoSource,
};

/** Recover only the completed provider result. This function can never submit a generation. */
export async function recoverFailedPhoto(source: FailedHeroSource | null, recipeId: string, kind: CutoutKind, targetId: string | null = null, ingredient?: Ingredient, storage: HeroRecoveryStorage = heroRecoveryStorage, preserveAlpha = false) {
  if (!isRecoverablePhotoSource(source, recipeId, kind, targetId, ingredient)) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono potwierdzonego zdjęcia do korekty tła.');
  const pathname = `ai/${source.id}/recovered-original.webp`;
  const retained = preserveAlpha ? null : await storage.retained?.(source, kind, targetId);
  const saved = (retained ? await storage.read(retained) : null)
    ?? await storage.read(pathname) ?? await storage.read(`ai/${source.id}/recovered-original.png`);
  let original = saved ?? await readProviderBackup(source.id, source.providerRequestId);
  if (!original) {
    const status = await client().queue.status(approvedModel, { requestId: source.providerRequestId, logs: false, abortSignal: AbortSignal.timeout(20_000) });
    if (status.status !== 'COMPLETED') throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Dostawca nie potwierdził dostępnego, zakończonego zdjęcia. Nie zlecono wycięcia ani nowej fotografii.');
    const result = await client().queue.result(approvedModel, { requestId: source.providerRequestId, abortSignal: AbortSignal.timeout(20_000) });
    const parsed = resultSchema.safeParse(result.data);
    if (!parsed.success) throw new ProviderError('AI_IMAGE_INVALID', 'Nie znaleziono jednej gotowej fotografii w istniejącym wyniku.');
    original = await downloadImage(parsed.data.images[0].url, 'reference');
  }
  if (original.byteLength > maxImageBytes) throw new ProviderError('AI_IMAGE_TOO_LARGE', 'Zachowane zdjęcie przekracza dopuszczalny rozmiar.');
  let metadata: Metadata;
  try { metadata = await sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata(); }
  catch { throw new ProviderError('AI_IMAGE_INVALID', 'Nie udało się odczytać gotowej fotografii. Nie zlecono nowej generacji.'); }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height < 655_360 || metadata.width > 3840 || metadata.height > 3840 || (metadata.pages ?? 1) !== 1 || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new ProviderError('AI_IMAGE_INVALID', 'Gotowa fotografia ma nieprawidłowy format lub wymiary.');
  // A previous strict corner check may have rejected an otherwise usable alpha.
  // Only the solid-hero caller normalizes and validates this exact retained frame.
  if (preserveAlpha) return original;
  await validateHeroCutoutSource(original, true);
  // Failed partial alpha must not reach fillEnclosedCutout as a non-opaque original.
  // Preserve the existing RGB pixels; the new SAM mask supplies the exterior alpha.
  const png = await sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' }).rotate().removeAlpha().png().toBuffer();
  if (saved) return png;
  // Persist the exact source before a SAM POST, so mask polling does not depend on the provider CDN lifetime.
  await storage.write(pathname, await losslessPhoto(png));
  return png;
}

async function formatHeroMask(original: Buffer, mask: Buffer, input: EditorialContent, kind: CutoutKind) {
  const cutout = await applyHeroMask(original, mask);
  const presentation = kind === 'hero' ? capturedHeroPresentation(input) : null;
  const formatted = presentation?.container === 'sauceboat'
    ? (await fillSauceboatInterior(original, cutout.bytes)).bytes
    : hasCookwareHandles(presentation) ? (await fillCookwareInterior(original, cutout.bytes)).bytes
    : isGlassHeroPresentation(presentation) ? cutout.bytes : (await fillEnclosedCutout(original, cutout.bytes)).bytes;
  if (kind === 'hero' && presentation?.container === 'glass') await validateGlassHeroCutout(formatted);
  else if (kind === 'hero' && !isGlassHeroPresentation(presentation)) await validateSolidHeroCutout(formatted);
  return formatted;
}

export async function recoverFailedHeroPhoto(source: FailedHeroSource | null, recipeId: string, storage: HeroRecoveryStorage = heroRecoveryStorage) {
  return recoverFailedPhoto(source, recipeId, 'hero', null, undefined, storage);
}

async function savePhoto(jobId: string, original: Buffer, formatted: Buffer, preservePixels = false, requestId?: string) {
  let metadata: Metadata;
  let originalMetadata: Metadata;
  try { [metadata, originalMetadata] = await Promise.all([sharp(formatted, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata(), sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata()]); }
  catch { throw new ProviderError('AI_IMAGE_INVALID', 'Nie udało się odczytać pliku fotograficznego.'); }
  if (!metadata.width || !metadata.height || metadata.width > 3840 || metadata.height > 3840 || (metadata.pages ?? 1) !== 1 || !['png', 'jpeg', 'webp'].includes(originalMetadata.format ?? '')) throw new ProviderError('AI_IMAGE_INVALID', 'Wynik ma nieprawidłowy format lub wymiary.');
  const { archive, web, shared } = requestId
    ? await withPhotoReadStage({ jobId, requestId, stage: 'photo-encode' }, () => compactPhoto(original, formatted, preservePixels))
    : await compactPhoto(original, formatted, preservePixels);
  // New immutable names also allow an older, interrupted PNG upload to be resumed.
  // A separate archive is content-addressed: a cutout re-encodes its generated
  // source deterministically, so both jobs share one lossless editing archive.
  const originalBlobPathname = shared ? `ai/${jobId}/original-v1.webp` : `ai/archive/v1/${createHash('sha256').update(archive).digest('hex')}.webp`;
  const blobPathname = shared ? originalBlobPathname : `ai/${jobId}/web-v1.webp`;
  await putOnce(originalBlobPathname, archive, 'image/webp', requestId ? { jobId, requestId, variant: 'archive' } : undefined);
  if (!shared) await putOnce(blobPathname, web, 'image/webp', requestId ? { jobId, requestId, variant: 'web' } : undefined);
  return { blobPathname, originalBlobPathname, width: metadata.width, height: metadata.height, contentType: 'image/webp' as const };
}

export async function formatExistingStep(input: EditorialContent, targetId: string | null, jobId: string) {
  const step = input.recipe.steps.find(item => item.id === targetId);
  const photo: MediaTile | undefined = targetId ? input.photos.steps[targetId] : undefined;
  if (!step || !photo) throw new ProviderError('AI_TARGET_MISSING', 'Wybrany krok nie ma zdjęcia do przycięcia.');
  try {
    const original = await readSourceImage(photo.src);
    const formatted = await checkedPhotoFormat(() => cropStepPhoto(original, photo));
    const saved = await savePhoto(jobId, original, formatted.bytes, true);
    return { done: true as const, asset: { ...saved, alt: photo.alt, caption: stepPhotoCaption(photo.caption ?? step.title), hasTransparency: false, styleProfile: 'jesie-culinary-editorial-v1' },
      cost: { chargedUsd: '0.00000000', costBasis: 'usage' as const }, notes: ['Istniejące zdjęcie przycięto do 21:9, bez rozciągania i ponownego generowania.'] };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('AI_IMAGE_FORMAT_FAILED', 'Nie udało się zapisać korekty istniejącego zdjęcia. Możesz ponowić bezpłatne przycięcie.');
  }
}

export async function formatExistingHero(input: EditorialContent, jobId: string) {
  const match = /^\/media\/([a-f0-9-]{36})$/.exec(input.recipe.image);
  const asset = match ? await getAssetForExecution(match[1]) : null;
  if (!asset || asset.recipeId !== input.recipe.id || asset.kind !== 'hero' || asset.model !== heroCutoutModel || !asset.originalBlobPathname) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono istniejącego wycięcia dania.');
  try {
    const apertures = preservesHeroApertures(input);
    const source = apertures ? await getJobForExecution(asset.jobId) : null;
    if (apertures && (!source || source.id !== asset.jobId || source.recipeId !== input.recipe.id || source.kind !== 'hero' || source.provider !== 'fal' || source.model !== heroCutoutModel || !['ready', 'applied'].includes(source.status) || !source.providerFinishedAt || !source.providerRequestId || !/^[A-Za-z0-9_-]{1,100}$/.test(source.providerRequestId) || source.result?.asset?.id !== asset.id)) {
      throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono potwierdzonej, zakończonej maski tego zdjęcia. Nie zlecono nowego wycięcia.');
    }
    const read = async (pathname: string) => {
      const blob = await getMediaBlob(pathname, { useCache: false });
      if (!blob || blob.statusCode !== 200) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie udało się odczytać istniejącego wycięcia dania.');
      return readBounded(blob.stream);
    };
    const original = await read(asset.originalBlobPathname);
    const formatted = apertures && source
      ? await checkedPhotoFormat(async () => {
        // Retrieve the accepted SAM result; never submit another paid mask.
        const cached = await readAcceptedMask(source.id);
        const mask = cached ?? await downloadImage(selectedMaskUrl((await client().queue.result(heroCutoutModel, { requestId: source.providerRequestId!, abortSignal: AbortSignal.timeout(20_000) })).data), 'reference');
        const cutout = await applyHeroMask(original, mask);
        const presentation = capturedHeroPresentation(input);
        if (presentation?.container === 'glass') await validateGlassHeroCutout(cutout.bytes);
        return presentation?.container === 'sauceboat' ? fillSauceboatInterior(original, cutout.bytes) : hasCookwareHandles(presentation) ? fillCookwareInterior(original, cutout.bytes) : cutout;
      })
      : await checkedPhotoFormat(async () => fillEnclosedCutout(original, await read(asset.blobPathname)));
    const saved = await savePhoto(jobId, original, formatted.bytes, true);
    return { done: true as const, asset: { ...saved, alt: input.recipe.title, caption: { pl: '', en: '' }, hasTransparency: true, styleProfile: capturedHeroProfile(input) },
      cost: { chargedUsd: '0.00000000', costBasis: 'usage' as const }, notes: [apertures
        ? 'Zachowano prześwity naczynia z istniejącej, zakończonej maski. Bez nowego płatnego zlecenia. Sprawdź szkło, uchwyt i całą potrawę.'
        : 'Zachowano zawartość naczynia w istniejącym wycięciu. Bez nowego płatnego zlecenia. Sprawdź brzeg naczynia i całą potrawę.'] };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('AI_IMAGE_FORMAT_FAILED', 'Nie udało się zapisać korekty wycięcia. Możesz ponowić bezpłatną korektę.');
  }
}

export type AcceptedPhotoReceiptSource = { id: string; provider: string; model: string; kind: string; providerRequestId: string | null; recipeId?: string; input?: EditorialContent; targetId?: string | null };
export type AcceptedPhotoReceiptInspection = {
  status: 'ineligible' | 'pending' | 'available' | 'unavailable';
  stage: 'eligibility' | 'provider-status' | 'provider-result' | 'result-schema' | 'mask-download' | 'source-read' | 'mask-apply' | 'cutout-fill' | 'cutout-validation' | 'photo-encode';
  providerStatus?: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';
  resultValidated: boolean; maskCount?: number; imageCount?: number;
  mediaValidated?: boolean;
  media?: { width: number; height: number; sourceBytes: number; sourceSha256: string; maskBytes: number; maskSha256: string; formattedBytes: number; formattedSha256: string; archiveBytes: number; archiveSha256: string; webBytes: number; webSha256: string };
  failure?: Pick<PhotoReadDiagnostic, 'errorClass' | 'code' | 'httpStatus' | 'httpDisposition'> & { redirectBlocked: boolean };
};

/** Inspect the already accepted provider receipt using GET only; never save, settle, submit, format or apply. */
export async function inspectAcceptedPhotoReceipt(job: AcceptedPhotoReceiptSource, inspectMedia = false): Promise<AcceptedPhotoReceiptInspection> {
  if (!/^[a-f0-9-]{36}$/i.test(job.id) || job.provider !== 'fal' || ![approvedModel, heroCutoutModel].includes(job.model)
    || !['hero', 'ingredient', 'step'].includes(job.kind) || !job.providerRequestId || !/^[A-Za-z0-9_-]{1,100}$/.test(job.providerRequestId)) {
    return { status: 'ineligible', stage: 'eligibility', resultValidated: false };
  }
  const input = job.input;
  const targetId = job.targetId ?? null;
  const deepIngredient = job.kind === 'ingredient' && Array.isArray(input?.recipe?.ingredients) ? input.recipe.ingredients.find(item => item.id === targetId) : undefined;
  if (inspectMedia && (job.model !== heroCutoutModel || !['hero', 'ingredient'].includes(job.kind) || !input?.recipe?.id
    || !input.photos?.ingredients || typeof input.recipe.image !== 'string'
    || job.recipeId && input.recipe.id !== job.recipeId || job.kind === 'ingredient' && !deepIngredient)) {
    return { status: 'ineligible', stage: 'eligibility', resultValidated: false, mediaValidated: false };
  }
  const requestId = job.providerRequestId;
  let stage: Exclude<AcceptedPhotoReceiptInspection['stage'], 'eligibility'> = 'provider-status';
  let providerStatus: AcceptedPhotoReceiptInspection['providerStatus'];
  let resultValidated = false;
  let maskCount: number | undefined;
  let maskHttpStatus: number | undefined;
  try {
    const status = await client().queue.status(job.model, { requestId, logs: false, abortSignal: AbortSignal.timeout(20_000) });
    providerStatus = status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS' || status.status === 'COMPLETED' ? status.status : 'UNKNOWN';
    if (providerStatus !== 'COMPLETED') return { status: 'pending', stage, providerStatus, resultValidated: false };
    stage = 'provider-result';
    const result = await client().queue.result(job.model, { requestId, abortSignal: AbortSignal.timeout(20_000) });
    stage = 'result-schema';
    if (job.model === heroCutoutModel) {
      const maskUrl = selectedMaskUrl(result.data);
      maskCount = (result.data as { masks: unknown[] }).masks.length;
      resultValidated = true;
      if (!inspectMedia) return { status: 'available', stage, providerStatus, resultValidated, maskCount };
      stage = 'mask-download';
      const mask = await downloadImage(maskUrl, 'reference', status => { maskHttpStatus = status; });
      stage = 'source-read';
      const captured = input!;
      const kind = job.kind as CutoutKind;
      const src = kind === 'hero' ? captured.recipe.image : targetId ? captured.photos.ingredients[targetId]?.src : undefined;
      if (!src) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono źródła istniejącego wycięcia.');
      let original: Buffer;
      if (src.startsWith(failedHeroSourcePrefix)) {
        const sourceId = src.slice(failedHeroSourcePrefix.length);
        if (!/^[a-f0-9-]{36}$/i.test(sourceId)) throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nieprawidłowe źródło istniejącego wycięcia.');
        const source = await getJobForExecution(sourceId);
        // Inspection can download a retained source, but must never populate its cache.
        original = await recoverFailedPhoto(source, captured.recipe.id, kind, targetId, deepIngredient, { ...heroRecoveryStorage, write: async () => {} });
      } else original = await readSourceImage(src, captured.recipe.id, kind, targetId, deepIngredient);
      stage = 'mask-apply';
      const cutout = await checkedPhotoFormat(() => applyHeroMask(original, mask));
      const presentation = kind === 'hero' ? capturedHeroPresentation(captured) : null;
      stage = 'cutout-fill';
      const formatted = presentation?.container === 'sauceboat'
        ? (await checkedPhotoFormat(() => fillSauceboatInterior(original, cutout.bytes))).bytes
        : hasCookwareHandles(presentation) ? (await checkedPhotoFormat(() => fillCookwareInterior(original, cutout.bytes))).bytes
        : isGlassHeroPresentation(presentation) ? cutout.bytes : (await checkedPhotoFormat(() => fillEnclosedCutout(original, cutout.bytes))).bytes;
      stage = 'cutout-validation';
      if (kind === 'hero' && presentation?.container === 'glass') await checkedPhotoFormat(() => validateGlassHeroCutout(formatted));
      else if (kind === 'hero' && !isGlassHeroPresentation(presentation)) await checkedPhotoFormat(() => validateSolidHeroCutout(formatted));
      stage = 'photo-encode';
      const encoded = await compactPhoto(original, formatted, true);
      const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      return { status: 'available', stage, providerStatus, resultValidated, maskCount, mediaValidated: true,
        media: { width: cutout.width, height: cutout.height, sourceBytes: original.length, sourceSha256: sha(original), maskBytes: mask.length, maskSha256: sha(mask), formattedBytes: formatted.length, formattedSha256: sha(formatted), archiveBytes: encoded.archive.length, archiveSha256: sha(encoded.archive), webBytes: encoded.web.length, webSha256: sha(encoded.web) } };
    }
    const parsed = resultSchema.safeParse(result.data);
    if (!parsed.success) throw new ProviderError('AI_IMAGE_INVALID', 'Nie potwierdzono struktury istniejącego wyniku zdjęcia.');
    return { status: 'available', stage, providerStatus, resultValidated: true, imageCount: parsed.data.images.length };
  } catch (error) {
    const observed = stage === 'mask-download' && maskHttpStatus !== undefined ? { cause: error, status: maskHttpStatus } : error;
    const { errorClass, code, httpStatus, httpDisposition } = photoReadDiagnostic({ jobId: job.id, requestId, stage }, error);
    const response = observed === error ? { httpStatus, httpDisposition } : photoReadDiagnostic({ jobId: job.id, requestId, stage }, observed);
    return { status: 'unavailable', stage, ...(providerStatus ? { providerStatus } : {}), resultValidated,
      ...(maskCount === undefined ? {} : { maskCount }), ...(inspectMedia ? { mediaValidated: false } : {}),
      failure: { errorClass, ...(code ? { code } : {}), ...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus, httpDisposition: response.httpDisposition }), redirectBlocked: photoReadRedirectBlocked(error) } };
  }
}

export async function pollImage(model: string, requestId: string, jobId: string, kind: Exclude<AiKind, 'recipe'>, input: EditorialContent, targetId: string | null, onTerminal?: () => Promise<void>) {
  const readStage = <T>(stage: PhotoReadStage, operation: () => T | Promise<T>) => withPhotoReadStage({ jobId, requestId, stage }, operation);
  const backup = model === approvedModel ? await readStage('provider-backup', () => readProviderBackup(jobId, requestId)) : null;
  const retainHeroMask = model === heroCutoutModel && kind === 'hero';
  const cachedMask = retainHeroMask ? await readStage('photo-archive-read', () => readAcceptedMask(jobId)) : null;
  const cachedManifest = retainHeroMask && !cachedMask ? await readStage('photo-archive-read', () => readMaskManifest(jobId)) : null;
  if (!backup && !cachedMask && !cachedManifest) {
    const status = await readStage('provider-status', () => client().queue.status(model, { requestId, logs: false, abortSignal: AbortSignal.timeout(20_000) }));
    if (status.status !== 'COMPLETED') return { done: false as const };
  }
  if (onTerminal) await readStage('terminal-record', onTerminal);
  const result = backup || cachedMask ? null : cachedManifest ? { data: cachedManifest } : await readStage('provider-result', () => client().queue.result(model, { requestId, abortSignal: AbortSignal.timeout(20_000) }));
  let original: Buffer;
  let formatted: Buffer;
  let hasTransparency = false;
  const manualComposition = model === approvedModel && kind === 'hero' && input.aiPhotography?.regenerate === true
    && input.aiPhotography.heroRetakeVersion !== 'vessel-cutout-v1';
  const standardSolidHero = model === approvedModel && kind === 'hero'
    && (input.aiPhotography?.regenerate !== true || input.aiPhotography.heroRetakeVersion === 'vessel-cutout-v1')
    && !isGlassHeroPresentation(capturedHeroPresentation(input));
  const standardGlassHero = model === approvedModel && kind === 'hero'
    && (input.aiPhotography?.regenerate !== true || input.aiPhotography.heroRetakeVersion === 'vessel-cutout-v1')
    && capturedHeroPresentation(input)?.container === 'glass';
  let normalizedHeroAlpha = false;
  let paddedHero = false;
  let restoredOriginalAlpha = false;
  let fullManualFrame = false;
  const ingredientProfile = capturedIngredientStyleProfile(input);
  const studioIngredient = model === approvedModel && kind === 'ingredient' && isOpaqueStudioIngredientProfile(ingredientProfile);
  if (model === heroCutoutModel) {
    const ingredient = kind === 'ingredient' ? input.recipe.ingredients.find(item => item.id === targetId) : undefined;
    const src = kind === 'hero' ? input.recipe.image : targetId && ingredient ? input.photos.ingredients[targetId]?.src : undefined;
    if (!src || kind !== 'hero' && kind !== 'ingredient') throw new ProviderError('AI_REFERENCE_UNAVAILABLE', 'Nie znaleziono źródła wycięcia.');
    const presentation = kind === 'hero' ? capturedHeroPresentation(input) : null;
    let restored: Buffer | null = null;
    let retainedOriginal: Buffer | null = null;
    if (kind === 'hero' && src.startsWith(failedHeroSourcePrefix) && !isGlassHeroPresentation(presentation)
      && input.aiPhotography?.regenerate !== true) {
      const source = await readStage('source-read', () => getJobForExecution(src.slice(failedHeroSourcePrefix.length)));
      retainedOriginal = await readStage('source-read', () => recoverFailedPhoto(source, input.recipe.id, 'hero', null, undefined, heroRecoveryStorage, true));
      const normalized = await readStage('cutout-validation', () => normalizeGeneratedHeroAlpha(retainedOriginal!));
      if (normalized) {
        try {
          await validateSolidHeroCutout(normalized.bytes);
          restored = normalized.bytes; paddedHero = normalized.padded; restoredOriginalAlpha = true;
        } catch (error) { if (!(error instanceof PhotoFormatError) || error.code !== 'PHOTO_CUTOUT_INVALID') throw error; }
      }
    }
    original = retainedOriginal && restored ? retainedOriginal : await readStage('source-read', () => readSourceImage(src, input.recipe.id, kind, targetId, ingredient));
    if (restored) formatted = restored;
    else {
      const format = (mask: Buffer) => readStage('cutout-validation', () => formatHeroMask(original, mask, input, kind));
      const select = async (data: unknown) => {
        const candidates = rankHeroMaskCandidates(data).sort((a, b) => a.index - b.index);
        candidates.forEach(candidate => approvedFalUrl(candidate.url));
        const manifest = { masks: candidates.map(candidate => ({ url: candidate.url })), scores: candidates.map(candidate => candidate.score) };
        // Retain the completed response before any candidate download. A
        // temporary read failure can resume even after the queue result expires.
        await putOnce(`ai/${jobId}/accepted-mask-candidates-v1.json`, Buffer.from(JSON.stringify(manifest)), 'application/json', { jobId, requestId, variant: 'archive' });
        let first = true;
        const selected = await checkedPhotoFormat(() => selectHeroMaskCandidate(manifest, {
          read: async candidate => {
            const pathname = `ai/${jobId}/accepted-mask-candidate-${candidate.index}-v1`;
            const mask = await readMaskArchive(pathname) ?? await readStage('mask-download', () => downloadImage(candidate.url));
            const contentType = await acceptedMaskContentType(mask);
            await putOnce(pathname, mask, contentType, { jobId, requestId, variant: 'archive' });
            if (first) { first = false; await putOnce(`ai/${jobId}/accepted-mask-v1`, mask, contentType, { jobId, requestId, variant: 'archive' }); }
            return mask;
          }, format,
        }));
        await putOnce(`ai/${jobId}/accepted-mask-v2`, selected.mask, await acceptedMaskContentType(selected.mask), { jobId, requestId, variant: 'archive' });
        return selected.formatted;
      };
      if (cachedMask) {
        try { formatted = await checkedPhotoFormat(() => format(cachedMask)); }
        catch (error) {
          if (!retainHeroMask || !(error instanceof ProviderError) || error.code !== 'AI_IMAGE_INVALID') throw error;
          const manifest = await readMaskManifest(jobId);
          if (manifest) { formatted = await select(manifest); }
          else {
            // A failed first candidate never replaces its immutable archive. Try
            // other masks retained from that same receipt, without another POST.
            let alternative: Buffer | null = null;
            for (let index = 0; index < 3; index++) {
              const mask = await readMaskArchive(`ai/${jobId}/accepted-mask-candidate-${index}-v1`);
              if (!mask || mask.equals(cachedMask)) continue;
              try {
                alternative = await checkedPhotoFormat(() => format(mask));
                await putOnce(`ai/${jobId}/accepted-mask-v2`, mask, await acceptedMaskContentType(mask), { jobId, requestId, variant: 'archive' }); break;
              } catch (candidateError) { if (!(candidateError instanceof ProviderError) || candidateError.code !== 'AI_IMAGE_INVALID') throw candidateError; }
            }
            if (!alternative) throw error;
            formatted = alternative;
          }
        }
      } else if (retainHeroMask) {
        formatted = await select(result?.data);
      } else {
        const mask = await readStage('mask-download', () => downloadImage(selectedMaskUrl(result?.data)));
        formatted = await checkedPhotoFormat(() => format(mask));
      }
    }
    hasTransparency = true;
  } else {
    if (backup) original = backup;
    else {
      const parsed = resultSchema.safeParse(result?.data);
      if (!parsed.success) throw new ProviderError('AI_IMAGE_INVALID', 'Dostawca nie zwrócił jednej poprawnej fotografii.');
      original = await downloadImage(parsed.data.images[0].url);
    }
    let generated: Metadata;
    try { generated = await sharp(original, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata(); }
    catch { throw new ProviderError('AI_IMAGE_INVALID', 'Nie udało się odczytać nowej fotografii.'); }
    if (!generated.width || !generated.height || generated.width * generated.height < 655_360 || generated.width > 3840 || generated.height > 3840 || (generated.pages ?? 1) !== 1 || !['png', 'jpeg', 'webp'].includes(generated.format ?? '')) throw new ProviderError('AI_IMAGE_INVALID', 'Nowa fotografia ma nieprawidłowy format lub wymiary.');
    formatted = kind === 'step' ? (await checkedPhotoFormat(() => cropStepPhoto(original))).bytes : original;
    if (standardSolidHero) {
      const normalized = await readStage('cutout-validation', () => normalizeGeneratedHeroAlpha(formatted));
      if (normalized && (normalized.changedPixels > 0 || normalized.padded)) { formatted = normalized.bytes; normalizedHeroAlpha = true; paddedHero = normalized.padded; }
    }
    if (studioIngredient) {
      // A studio product image keeps its generated background and contact
      // shadow. Reject transparency instead of inventing alpha or buying SAM.
      if (generated.hasAlpha && (await sharp(original).stats()).channels.at(-1)?.min !== 255) throw new ProviderError('AI_IMAGE_INVALID', ingredientProfile === paperIngredientStyleProfile
        ? 'Fotografia składnika na tle serwisu musi zachować nieprzezroczyste tło i naturalny cień.'
        : 'Fotografia składnika na białym tle musi zachować nieprzezroczyste tło i naturalny cień.');
    } else if (kind !== 'step') {
      if (manualComposition) await readStage('cutout-validation', () => checkedPhotoFormat(() => validateVisiblePhoto(formatted)));
      try { await (standardSolidHero ? validateSolidHeroCutout(formatted) : standardGlassHero ? validateGlassHeroCutout(formatted) : validateCutout(formatted)); hasTransparency = true; }
      catch (error) {
        if (!(error instanceof PhotoFormatError) || error.code !== 'PHOTO_CUTOUT_INVALID') throw error;
        if (manualComposition) {
          // A vessel mask cannot describe arbitrary editor-requested props. Keep
          // the complete accepted image for review instead of buying segmentation.
          fullManualFrame = true;
        } else {
        // The paid photograph exists even when its alpha does not meet the cutout
        // contract. Pin its exact decoded RGB and alpha before recording failure;
        // recovery reads this same source without generating another photograph.
        // Storage failures must propagate with their original retry/uncertainty semantics.
        await readStage('photo-save', async () => {
          const retained = await readStage('photo-encode', () => losslessPhoto(original));
          await putOnce(`ai/${jobId}/recovered-original.webp`, retained, 'image/webp', { jobId, requestId, variant: 'archive' });
        });
        throw new ProviderError('AI_TRANSPARENCY_MISSING', 'Fotografia powstała i została zachowana, ale wymaga wycięcia tła. Użyj korekty gotowego zdjęcia, bez ponownego generowania.');
        }
      }
    }
  }
  const saved = await readStage('photo-save', () => savePhoto(jobId, original, formatted, model === heroCutoutModel || studioIngredient || manualComposition || normalizedHeroAlpha, requestId));
  const recipe = input.recipe;
  const ingredient = recipe.ingredients.find(item => item.id === targetId);
  const step = recipe.steps.find(item => item.id === targetId);
  const alt = kind === 'hero' ? recipe.title : kind === 'ingredient' ? ingredient!.name : step!.title;
  const caption = kind === 'step' ? stepPhotoCaption(step!.title) : { pl: '', en: '' };
  return { done: true as const,
    asset: { ...saved, alt, caption, hasTransparency, styleProfile: kind === 'ingredient' ? ingredientProfile : kind === 'hero' ? capturedHeroProfile(input) : 'jesie-culinary-editorial-v1' },
    cost: await imageBill(requestId) ?? {},
    notes: [...(restoredOriginalAlpha ? ['Odzyskano pełną potrawę z przezroczystości zachowanego oryginału zamiast maski usuwającej jedzenie. Bez nowej generacji ani nowego wycięcia.'] : []), ...(paddedHero ? ['Dodano pusty, przezroczysty margines wokół dostarczonego kadru, bez zmiany pikseli potrawy. Sprawdź cały uchwyt i kadr przed zapisem.'] : []), fullManualFrame ? 'Zachowano pełny kadr bez automatycznego wycinania. Sprawdź tło, całą potrawę i wskazane rekwizyty przed zastosowaniem zdjęcia do przepisu.' : studioIngredient ? ingredientProfile === paperIngredientStyleProfile
      ? `Zachowano pełną fotografię produktu na tle serwisu ${ingredientStudioBackgroundHex} i naturalny cień, bez wycinania tła. Sprawdź produkt, jego postać i zgodność tła z serwisem.`
      : 'Zachowano pełną fotografię produktu na białym tle i naturalny cień, bez wycinania tła. Sprawdź produkt, jego postać i białe tło.'
      : model === heroCutoutModel ? kind === 'ingredient' ? 'Wycięto tło gotowego zdjęcia składnika, bez ponownego generowania. Sprawdź kompletność produktu i jego naczynia.' : 'Wycięto obecne zdjęcie. Sprawdź cały brzeg naczynia i brak tła lub serwetki.' : 'Zdjęcie wymaga przeglądu zgodności potrawy, składników i detalu.', ...(kind === 'ingredient' && !studioIngredient ? ['Sprawdź przezroczystość brzegów i poprawną postać składnika.'] : [])],
  };
}

export async function cancelImage(model: string, requestId: string) { await client().queue.cancel(model, { requestId }); }
