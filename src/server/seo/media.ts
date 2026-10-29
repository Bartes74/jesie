import 'server-only';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BlobError, get, put } from '@vercel/blob';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { getRecipeImageVariants, recipeImageVersion, type RecipeImageSource, type RecipeImageVariant } from '@/lib/recipe-image-variants';
import { normalizeHeroPresentation } from '@/server/ai/hero-presentation';
import { getMediaBlob } from '@/server/media/storage';
import { mediaVariantInput, type MediaDeliveryVariantCache } from '@/server/media/delivery-variant-cache';
import { durableMediaDeliveryVariants } from '@/server/media/delivery-variant-store';
import type { DeliveryPhoto } from '@/server/media/delivery';
import { getStaticMediaVariant } from '@/server/media/static-delivery';

const maximumSourceBytes = 32 * 1024 * 1024;
const maximumDeliveryBytes = 4 * 1024 * 1024;
const maximumPixels = 8_500_000;
const paper = '#FAF8F2';
export const publicMediaCacheControl = 'public, max-age=0, s-maxage=300, must-revalidate';
export const publicHeroWidths = [320, 640, 960, 1280, 1600] as const;
export type PublicHeroWidth = typeof publicHeroWidths[number];

/** Undefined uses the original canvas; null rejects ambiguous or unsupported query values. */
export function parsePublicHeroWidth(search: URLSearchParams): PublicHeroWidth | undefined | null {
  const values = search.getAll('w');
  if (!values.length) return undefined;
  if (values.length !== 1 || !/^(320|640|960|1280|1600)$/.test(values[0])) return null;
  return Number(values[0]) as PublicHeroWidth;
}

// ponytail: sharing crops (social, Pinterest) are paused while hero photography is reworked;
// they still render on first request for existing og:image links. Remove the filter to resume.
const pausedSharingVariants = new Set(['social', 'pinterest']);
function prewarmedVariants(recipe: RecipeImageSource) {
  return Object.entries(getRecipeImageVariants(recipe)).filter(([name]) => !pausedSharingVariants.has(name)).map(([, variant]) => variant);
}

export type StoredMedia ={ stream: ReadableStream<Uint8Array>; size?: number; contentType?: string };
export type RecipeMediaAsset = { id: string; recipeId: string; kind: string; blobPathname: string };
export type RecipeMediaDependencies = {
  publishedRecipe: (id: string) => Promise<RecipeImageSource | null>;
  asset: (id: string) => Promise<RecipeMediaAsset | null>;
  assetPublic: (id: string) => Promise<boolean>;
  readStored: (pathname: string, useCache?: boolean) => Promise<StoredMedia | null>;
  writeStored: (pathname: string, bytes: Buffer) => Promise<void>;
  readStatic: (src: string) => Promise<Buffer>;
  persistDerivatives?: boolean;
  variants?: MediaDeliveryVariantCache;
  staticVariant?: (src: string, target: Pick<RecipeImageVariant, 'width' | 'height'>) => Promise<DeliveryPhoto>;
};

/** A full Hobby store must not turn an optional delivery cache into an outage. */
function isStorageQuotaExceeded(error: unknown): boolean {
  return error instanceof BlobError && /\bstorage quota exceeded\b/i.test(error.message);
}

export async function writeRecipeMediaOnce(pathname: string, bytes: Buffer, dependencies: {
  put: (pathname: string, bytes: Buffer) => Promise<void>;
  readFresh: (pathname: string) => Promise<StoredMedia | null>;
}): Promise<void> {
  try { await dependencies.put(pathname, bytes); }
  catch (originalError) {
    // Concurrent publication events can finish the same immutable variant. Blob
    // reports existing-path errors differently from an ifMatch/ETag conflict.
    let existing: StoredMedia | null;
    try { existing = await dependencies.readFresh(pathname); }
    catch { throw originalError; }
    if (!existing) throw originalError;
    const usable = existing.contentType === 'image/webp' && Number.isInteger(existing.size)
      && existing.size! > 0 && existing.size! <= maximumDeliveryBytes;
    await existing.stream.cancel().catch(() => {});
    if (!usable) throw originalError;
  }
}

function assertRasterSource(source: Buffer) {
  const png = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = source[0] === 255 && source[1] === 216 && source[2] === 255;
  const webp = source.subarray(0, 4).toString('ascii') === 'RIFF' && source.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!source.length || source.length > maximumSourceBytes || !(png || jpeg || webp)) throw new Error('Invalid raster recipe photograph');
}

/** Reject remote sources and traversal before any network or filesystem access. */
export function isStaticRecipeImage(src: string): boolean {
  return /^\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:webp|png|jpe?g)$/.test(src)
    && !/\/(?:ingredients-|steps-)/.test(src);
}

export async function readBoundedMedia(media: StoredMedia, maximum = maximumSourceBytes): Promise<Buffer> {
  if (media.size !== undefined && media.size > maximum) {
    await media.stream.cancel().catch(() => {});
    throw new Error('Recipe photograph exceeds the size limit');
  }
  const reader = media.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Recipe photograph exceeds the size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function renderRecipeImageVariant(source: Buffer, size: Pick<RecipeImageVariant, 'width' | 'height'>): Promise<Buffer> {
  assertRasterSource(source);
  const image = sharp(source, { limitInputPixels: maximumPixels, failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || !['png', 'webp', 'jpeg'].includes(metadata.format ?? '')) throw new Error('Invalid recipe photograph');
  const transparent = metadata.hasAlpha && (await image.stats()).channels.at(-1)!.min < 255;
  const framed = transparent ? await normalizeHeroPresentation(source) : null;
  const delivery = framed ? sharp(framed.bytes, { limitInputPixels: maximumPixels, failOn: 'error' }) : image;
  // Preserve a complete vessel in cutout photography; opaque editorial photos can be reframed.
  const result = await delivery.rotate().resize(size.width, size.height, {
    fit: transparent ? 'contain' : 'cover', position: transparent ? 'centre' : sharp.strategy.attention,
    background: paper,
  }).flatten({ background: paper }).webp({ quality: 88, effort: 5 }).toBuffer();
  if (result.length > maximumDeliveryBytes) throw new Error('Prepared recipe photograph exceeds the delivery limit');
  return result;
}

/** Keep the established complete transparent canvas and full-frame link. */
export async function renderPublishedHeroMaster(source: Buffer): Promise<DeliveryPhoto> {
  assertRasterSource(source);
  const display = await normalizeHeroPresentation(source);
  const normalized = display?.bytes ?? source;
  let result = await sharp(normalized, { limitInputPixels: maximumPixels, failOn: 'error' }).webp({ lossless: true, effort: 4 }).toBuffer();
  if (result.length > maximumDeliveryBytes) result = await sharp(normalized, { limitInputPixels: maximumPixels, failOn: 'error' }).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toBuffer();
  if (result.length > maximumDeliveryBytes) throw new Error('Prepared hero exceeds the delivery limit');
  const metadata = await sharp(result, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Invalid hero dimensions');
  return { bytes: result, width: metadata.width, height: metadata.height };
}

function derivativePath(url: string) { return `seo/${url.replace(/^\/media\//, '')}`; }
export function publishedHeroPath(id: string, width?: PublicHeroWidth) { return `seo/delivery/${id}/v1${width ? `-w${width}` : ''}.webp`; }

export function createRecipeMediaService(dependencies: RecipeMediaDependencies) {
  const asStored = (photo: DeliveryPhoto): StoredMedia => ({ stream: new Response(new Uint8Array(photo.bytes)).body!, size: photo.bytes.length, contentType: 'image/webp' });
  async function variant(asset: RecipeMediaAsset, variantKey: string, load: () => Promise<{ source: Buffer; photo: DeliveryPhoto }>): Promise<DeliveryPhoto> {
    const input = mediaVariantInput(asset, variantKey);
    if (dependencies.variants) {
      try {
        const ready = await dependencies.variants.read(input); if (ready) return ready;
        const prepared = await dependencies.variants.prepare?.(input, load); if (prepared) return prepared;
      } catch { /* Private derivative storage is optional; retained photographs remain authoritative. */ }
    }
    const rendered = await load();
    if (dependencies.variants && !dependencies.variants.prepare) {
      try { await dependencies.variants.write(input, rendered.source, rendered.photo); } catch { /* Serve the retained source rendering. */ }
    }
    return rendered.photo;
  }
  async function cacheDerivative(pathname: string, bytes: Buffer): Promise<boolean> {
    if (dependencies.persistDerivatives === false) return false;
    try { await dependencies.writeStored(pathname, bytes); return true; }
    catch (error) {
      // Source assets still need a successful durable write. Only this reproducible
      // delivery cache can fall back to rendering bytes for the CDN response.
      if (!isStorageQuotaExceeded(error)) throw error;
      return false;
    }
  }
  async function stored(pathname: string) {
    // CDN-only delivery must not depend on an optional Blob cache that may be
    // inaccessible after the source store reaches its Hobby usage limit.
    if (dependencies.persistDerivatives === false && pathname.startsWith('seo/')) return null;
    const cached = await dependencies.readStored(pathname, true);
    return cached ?? dependencies.readStored(pathname, false);
  }
  async function source(recipe: RecipeImageSource): Promise<{ bytes: Buffer; asset?: RecipeMediaAsset }> {
    if (isStaticRecipeImage(recipe.image)) return { bytes: await dependencies.readStatic(recipe.image) };
    const id = /^\/media\/([a-f0-9-]{36})$/.exec(recipe.image)?.[1];
    if (!id) throw new Error('Unsupported recipe photograph source');
    const asset = await dependencies.asset(id);
    // A reviewed duplicate can reuse a registered photograph. Its active immutable
    // snapshot grants access; the original generation's recipeId is provenance.
    if (!asset || asset.id !== id || asset.kind !== 'hero') throw new Error('Recipe photograph is not an authorized finished dish');
    const original = await stored(asset.blobPathname);
    if (!original) throw new Error('Recipe photograph is unavailable');
    return { bytes: await readBoundedMedia(original), asset };
  }
  async function heroDelivery(asset: RecipeMediaAsset, width?: PublicHeroWidth, sourceBytes?: Buffer): Promise<StoredMedia> {
    if (width !== undefined && !(publicHeroWidths as readonly number[]).includes(width)) throw new Error('Unsupported hero image width');
    const pathname = publishedHeroPath(asset.id, width);
    const ready = await stored(pathname);
    if (ready) return ready;
    if (width) {
      // The cached master supplies exactly the same centred canvas as the UI's
      // original photograph. Resize without cropping or flattening its alpha.
      const master = await heroDelivery(asset);
      const normalized = await readBoundedMedia(master, maximumDeliveryBytes);
      const result = await sharp(normalized, { limitInputPixels: maximumPixels, failOn: 'error' })
        .resize({ width, withoutEnlargement: true }).webp({ quality: 88, alphaQuality: 100, effort: 5 }).toBuffer();
      if (result.length > maximumDeliveryBytes) throw new Error('Responsive hero exceeds the delivery limit');
      // The response CDN caches each width. Persisting every screen size again
      // would duplicate the original and normalized master in the small store.
      return { stream: new Response(new Uint8Array(result)).body!, size: result.length, contentType: 'image/webp' };
    }
    if (dependencies.variants) {
      return asStored(await variant(asset, 'hero:full', async () => {
        const original = sourceBytes ? null : await stored(asset.blobPathname);
        if (!sourceBytes && !original) throw new Error('Recipe photograph is unavailable');
        const source = sourceBytes ?? await readBoundedMedia(original!);
        return { source, photo: await renderPublishedHeroMaster(source) };
      }));
    }
    const original = sourceBytes ? null : await stored(asset.blobPathname);
    if (!sourceBytes && !original) throw new Error('Recipe photograph is unavailable');
    const bytes = sourceBytes ?? await readBoundedMedia(original!);
    const result = (await renderPublishedHeroMaster(bytes)).bytes;
    await cacheDerivative(pathname, result);
    return { stream: new Response(new Uint8Array(result)).body!, size: result.length, contentType: 'image/webp' };
  }
  async function publicHeroDelivery(asset: RecipeMediaAsset, width?: PublicHeroWidth): Promise<StoredMedia | null> {
    if (asset.kind !== 'hero' || !await dependencies.assetPublic(asset.id)) return null;
    const image = await heroDelivery(asset, width);
    if (!await dependencies.assetPublic(asset.id)) { await image.stream.cancel().catch(() => {}); return null; }
    return image;
  }
  async function prepareRecipeMedia(input: RecipeImageSource): Promise<void> {
    const recipe = await dependencies.publishedRecipe(input.id);
    if (!recipe || recipe.image !== input.image) throw new Error('Only the current published recipe photograph can be prepared');
    if ((dependencies.variants && /^\/media\/[a-f0-9-]{36}$/.test(recipe.image))
      || (dependencies.staticVariant && isStaticRecipeImage(recipe.image))) {
      // Durable preparation reuses the ordinary authorized named-image reader.
      // Each immutable target acquires its own fenced claim before rendering.
      for (const named of prewarmedVariants(recipe)) {
        const parts = named.url.split('/');
        const image = await recipeImage(recipe.id, parts.at(-2)!, parts.at(-1)!);
        await image?.stream.cancel().catch(() => {});
      }
      const id = /^\/media\/([a-f0-9-]{36})$/.exec(recipe.image)?.[1];
      const asset = id ? await dependencies.asset(id) : null;
      if (asset?.kind === 'hero') await (await heroDelivery(asset)).stream.cancel().catch(() => {});
      return;
    }
    let loaded: Awaited<ReturnType<typeof source>> | undefined;
    for (const variant of prewarmedVariants(recipe)) {
      const pathname = derivativePath(variant.url);
      const ready = await stored(pathname);
      if (ready) { await ready.stream.cancel().catch(() => {}); continue; }
      loaded ??= await source(recipe);
      const bytes = await renderRecipeImageVariant(loaded.bytes, variant);
      // Prewarming is optional. Stop once storage is full; first access can still
      // produce the authorized image without retrying all remaining cache writes.
      if (!await cacheDerivative(pathname, bytes)) return;
    }
    // Prepare the actual transparent UI hero too, keeping all retained subject pixels.
    const heroId = /^\/media\/([a-f0-9-]{36})$/.exec(recipe.image)?.[1];
    const asset = loaded?.asset ?? (heroId ? await dependencies.asset(heroId) : null);
    if (asset && asset.id === heroId && asset.kind === 'hero') {
      const display = await heroDelivery(asset, undefined, loaded?.bytes);
      await display.stream.cancel().catch(() => {});
    }
  }
  async function recipeImage(id: string, version: string, filename: string): Promise<StoredMedia | null> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^v1-[a-f0-9]{32}$/.test(version) || !/^[a-z0-9-]+\.webp$/.test(filename)) return null;
    const recipe = await dependencies.publishedRecipe(id);
    if (!recipe || recipeImageVersion(recipe.image) !== version) return null;
    const variant = Object.values(getRecipeImageVariants(recipe)).find(item => item.url.split('/').at(-1) === filename);
    if (!variant) return null;
    const assetId = /^\/media\/([a-f0-9-]{36})$/.exec(recipe.image)?.[1];
    if (dependencies.variants && assetId) {
      const asset = await dependencies.asset(assetId);
      if (!asset || asset.kind !== 'hero') return null;
      const photo = await durableRecipeVariant(asset, recipe, variant);
      const current = await dependencies.publishedRecipe(id);
      return current?.image === recipe.image ? asStored(photo) : null;
    }
    if (dependencies.staticVariant && isStaticRecipeImage(recipe.image)) {
      const photo = await dependencies.staticVariant(recipe.image, variant);
      const current = await dependencies.publishedRecipe(id);
      return current?.image === recipe.image ? asStored(photo) : null;
    }
    const ready = await stored(derivativePath(variant.url));
    if (ready) {
      const current = await dependencies.publishedRecipe(id);
      if (!current || current.image !== recipe.image) { await ready.stream.cancel().catch(() => {}); return null; }
      return ready;
    }
    // Legacy snapshots acquire a derivative on first access without a new editorial publication.
    const original = await source(recipe);
    const bytes = await renderRecipeImageVariant(original.bytes, variant);
    await cacheDerivative(derivativePath(variant.url), bytes);
    // A withdrawal during preparation must not turn a private snapshot into a new public response.
    const current = await dependencies.publishedRecipe(id);
    if (!current || current.image !== recipe.image) return null;
    return { stream: new Response(new Uint8Array(bytes)).body!, size: bytes.length, contentType: 'image/webp' };
  }
  async function durableRecipeVariant(asset: RecipeMediaAsset, recipe: RecipeImageSource, target: RecipeImageVariant): Promise<DeliveryPhoto> {
    return variant(asset, `recipe:${target.width}x${target.height}`, async () => {
      const original = await source(recipe);
      return { source: original.bytes, photo: { bytes: await renderRecipeImageVariant(original.bytes, target), width: target.width, height: target.height } };
    });
  }
  return { prepareRecipeMedia, recipeImage, heroDelivery, publicHeroDelivery };
}

async function readStatic(src: string): Promise<Buffer> {
  if (!isStaticRecipeImage(src)) throw new Error('Invalid static recipe photograph path');
  const images = await realpath(path.join(process.cwd(), 'public/images'));
  const target = await realpath(path.join(process.cwd(), 'public', src));
  if (!target.startsWith(`${images}${path.sep}`)) throw new Error('Recipe photograph leaves its public directory');
  const file = await stat(target);
  if (!file.isFile() || file.size > maximumSourceBytes) throw new Error('Invalid static recipe photograph size');
  return readFile(target);
}

function storageConfigured() { return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }
async function isHeroAssetPublished(id: string): Promise<boolean> {
  const { getDb } = await import('@/server/db');
  const result = await getDb().execute(sql`SELECT 1 FROM editorial_recipe r
    JOIN editorial_publication p ON p.id=r.published_id
    WHERE r.publication_status='published' AND r.deleted_at IS NULL
      AND p.snapshot->'recipe'->>'image'=${`/media/${id}`} LIMIT 1`);
  return result.rows.length > 0;
}
const media = createRecipeMediaService({
  // Immutable private variants are reused behind the existing publication ACL.
  persistDerivatives: false,
  variants: durableMediaDeliveryVariants,
  staticVariant: (src, target) => getStaticMediaVariant(src, `recipe:${target.width}x${target.height}`, async source => ({
    bytes: await renderRecipeImageVariant(source, target), width: target.width, height: target.height,
  })),
  publishedRecipe: async id => (await import('@/server/editorial/store')).getPublishedRecipeById(id),
  asset: async id => (await import('@/server/ai/store')).getAssetForExecution(id),
  assetPublic: isHeroAssetPublished,
  readStatic,
  readStored: async (pathname, useCache = true) => {
    if (!storageConfigured()) return null;
    const blob = await getMediaBlob(pathname, { useCache });
    return blob?.statusCode === 200 ? { stream: blob.stream, size: blob.blob.size, contentType: blob.blob.contentType } : null;
  },
  writeStored: async (pathname, bytes) => {
    // Local legacy fixtures can be rendered without storage; production reuses its existing private store.
    if (!storageConfigured()) return;
    await writeRecipeMediaOnce(pathname, bytes, {
      put: async (target, data) => { await put(target, data, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'image/webp' }); },
      readFresh: async target => {
        const existing = await get(target, { access: 'private', useCache: false });
        return existing?.statusCode === 200 ? { stream: existing.stream, size: existing.blob.size, contentType: existing.blob.contentType } : null;
      },
    });
  },
});
export const prepareRecipeMedia = media.prepareRecipeMedia;
export const getPublishedRecipeImage = media.recipeImage;
/** The public accessor verifies an active snapshot both before and after preparing or reading pixels. */
export const getPublishedHeroDelivery = media.publicHeroDelivery;
