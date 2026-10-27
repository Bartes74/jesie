import 'server-only';
import sharp from 'sharp';
import { mediaDeliveryWidths, type MediaDeliveryWidth } from '@/lib/media-delivery';
import { normalizeHeroPresentationRaster } from '@/server/ai/hero-presentation';
import { deliveryVariantInput, type MediaDeliveryVariantCache } from './delivery-variant-cache';

export type DeliveryPhotoKind = 'hero' | 'ingredient' | 'step';
export type DeliveryPhoto = { bytes: Buffer; width: number; height: number };
const maximumSourceBytes = 32 * 1024 * 1024;
const maximumPixels = 8_500_000;
const maximumDeliveryBytes = 4 * 1024 * 1024;
const quality = { hero: 84, ingredient: 80, step: 82 } as const;

/** Presentation variants never replace or write an editing archive. No crops or enlargement. */
export async function renderMediaDelivery(source: Buffer, kind: DeliveryPhotoKind, width: MediaDeliveryWidth): Promise<DeliveryPhoto> {
  if (!(mediaDeliveryWidths as readonly number[]).includes(width) || !Object.hasOwn(quality, kind)) throw new Error('Unsupported media delivery variant');
  const png = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = source[0] === 255 && source[1] === 216 && source[2] === 255;
  const webp = source.subarray(0, 4).toString('ascii') === 'RIFF' && source.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!source.length || source.length > maximumSourceBytes || !(png || jpeg || webp)) throw new Error('Invalid raster delivery source');
  const options = { limitInputPixels: maximumPixels, failOn: 'error' as const };
  const metadata = await sharp(source, options).metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || !['png', 'webp', 'jpeg'].includes(metadata.format ?? '')) throw new Error('Invalid raster delivery source');
  const framed = kind === 'hero' ? await normalizeHeroPresentationRaster(source) : null;
  const image = framed
    ? sharp(framed.pixels, { raw: { width: framed.width, height: framed.height, channels: 4 } })
    : sharp(source, options);
  const { data, info } = await image.rotate().resize({ width, withoutEnlargement: true })
    .webp({ quality: quality[kind], alphaQuality: 100, exact: true, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  if (data.length > maximumDeliveryBytes) throw new Error('Media delivery exceeds the size limit');
  return { bytes: data, width: info.width, height: info.height };
}

export type DeliveryAsset = { id: string; kind: string; blobPathname: string };
type Dependencies = {
  isPublic: (id: string) => Promise<boolean>;
  isAdmin: (headers?: Headers) => Promise<boolean>;
  read: (pathname: string) => Promise<Buffer | null>;
  render?: typeof renderMediaDelivery;
  variants?: MediaDeliveryVariantCache;
};

/** A bounded, ephemeral pixel cache. Every hit still passes live publication/session checks. */
export function createMediaDeliveryService(dependencies: Dependencies) {
  const cache = new Map<string, DeliveryPhoto>();
  const inflight = new Map<string, Promise<DeliveryPhoto | null>>();
  const maximumCacheBytes = 24 * 1024 * 1024;
  const maximumCacheEntries = 128;
  let cacheBytes = 0;
  return async (asset: DeliveryAsset, width: MediaDeliveryWidth, headers?: Headers): Promise<(DeliveryPhoto & { public: boolean }) | null> => {
    if (!/^[a-f0-9-]{36}$/.test(asset.id) || !['hero', 'ingredient', 'step'].includes(asset.kind)
      || !(mediaDeliveryWidths as readonly number[]).includes(width)) return null;
    const publicAsset = await dependencies.isPublic(asset.id);
    if (!publicAsset && !await dependencies.isAdmin(headers)) return null;
    const key = JSON.stringify([asset.id, asset.blobPathname, asset.kind, width]);
    let photo = cache.get(key);
    if (photo) { cache.delete(key); cache.set(key, photo); }
    else {
      const load = async () => {
        const render = async () => {
          const source = await dependencies.read(asset.blobPathname);
          if (!source) return null;
          const photo = await (dependencies.render ?? renderMediaDelivery)(source, asset.kind as DeliveryPhotoKind, width);
          return { source, photo };
        };
        let input: ReturnType<typeof deliveryVariantInput> | undefined;
        if (dependencies.variants) {
          try {
            input = deliveryVariantInput(asset, width);
            const stored = await dependencies.variants.read(input);
            if (stored) return stored;
            if (dependencies.variants.prepare) {
              const prepared = await dependencies.variants.prepare(input, render);
              if (prepared) return prepared;
            }
          } catch { /* An optional cache cannot make the retained source unavailable. */ }
        }
        const rendered = await render();
        if (!rendered) return null;
        if (input && dependencies.variants && !dependencies.variants.prepare) {
          try { await dependencies.variants.write(input, rendered.source, rendered.photo); }
          catch { /* Serve the existing rendering if the derivative store is unavailable. */ }
        }
        return rendered.photo;
      };
      let pending = inflight.get(key);
      if (!pending) {
        pending = load();
        inflight.set(key, pending);
      }
      try { photo = await pending ?? undefined; }
      finally { if (inflight.get(key) === pending) inflight.delete(key); }
      if (!photo) return null;
      // Store only thumbnails, never full-resolution sources. LRU eviction is
      // independent of publication permissions; the next request rechecks them.
      if (photo.bytes.length <= maximumCacheBytes) {
        const previous = cache.get(key);
        if (previous) cacheBytes -= previous.bytes.length;
        cache.delete(key); cache.set(key, photo); cacheBytes += photo.bytes.length;
        while (cacheBytes > maximumCacheBytes || cache.size > maximumCacheEntries) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)!.bytes.length; cache.delete(oldest);
        }
      }
    }
    // A withdrawal during decoding (or a cache hit) cannot create a public response.
    if (publicAsset && !await dependencies.isPublic(asset.id)) return null;
    return { ...photo, public: publicAsset };
  };
}
