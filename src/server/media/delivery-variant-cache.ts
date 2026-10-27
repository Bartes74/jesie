import 'server-only';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { DeliveryAsset, DeliveryPhoto, DeliveryPhotoKind } from './delivery';
import { mediaDeliveryWidths, type MediaDeliveryWidth } from '@/lib/media-delivery';

// Increment when framing, sizing or encoder settings change. A deployment must
// never reinterpret an old immutable derivative as a different rendering.
export const mediaDeliveryRendererVersion = 'webp-delivery-v1';
export const maximumDeliveryVariantBytes = 4 * 1024 * 1024;
export const maximumDeliverySourceBytes = 32 * 1024 * 1024;
const maximumPixels = 8_500_000;
const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export type MediaDeliveryVariantInput = {
  assetId: string;
  sourcePathname: string;
  kind: DeliveryPhotoKind;
  variantKey: string;
  rendererVersion: string;
};
export type MediaDeliveryVariantRecord = MediaDeliveryVariantInput & {
  key: string;
  sourceSha256: string;
  sourceBytes: number;
  blobPathname: string;
  contentSha256: string;
  byteLength: number;
  width: number;
  height: number;
};

export interface MediaDeliveryVariantCache {
  read(input: MediaDeliveryVariantInput): Promise<DeliveryPhoto | null>;
  write(input: MediaDeliveryVariantInput, source: Buffer, photo: DeliveryPhoto): Promise<boolean>;
  prepare?(input: MediaDeliveryVariantInput, load: () => Promise<{ source: Buffer; photo: DeliveryPhoto } | null>): Promise<DeliveryPhoto | null>;
}
export type DeliveryVariantCacheDependencies = {
  find(input: MediaDeliveryVariantInput): Promise<MediaDeliveryVariantRecord | null>;
  // This must create an immutable private object or verify an identical winner.
  // It must never overwrite an existing path, including after a transport error.
  writeOnce(record: MediaDeliveryVariantRecord, bytes: Buffer): Promise<void>;
  readBlob(pathname: string, maximumBytes: number): Promise<Buffer | null>;
  register(record: MediaDeliveryVariantRecord): Promise<MediaDeliveryVariantRecord>;
  invalidate?(record: MediaDeliveryVariantRecord): Promise<void>;
};

export function deliveryVariantInput(asset: DeliveryAsset, width: MediaDeliveryWidth): MediaDeliveryVariantInput {
  return mediaVariantInput(asset, `responsive:${width}`);
}

export function mediaVariantInput(asset: DeliveryAsset, variantKey: string): MediaDeliveryVariantInput {
  const input = { assetId: asset.id, sourcePathname: asset.blobPathname, kind: asset.kind as DeliveryPhotoKind,
    variantKey, rendererVersion: mediaDeliveryRendererVersion };
  if (!validVariantInput(input)) throw new Error('Invalid media delivery variant input');
  return input;
}

export function deliveryVariantDimensions(input: MediaDeliveryVariantInput): { width: number; height?: number; exact: boolean } | null {
  const responsive = /^responsive:(\d+)$/.exec(input.variantKey);
  if (responsive && (mediaDeliveryWidths as readonly number[]).includes(Number(responsive[1]))) return { width: Number(responsive[1]), exact: false };
  if (input.kind !== 'hero') return null;
  if (input.variantKey === 'hero:full') return { width: 3840, exact: false };
  const recipe = /^recipe:(1600x1200|1600x900|1200x1200|1200x630|1000x1500)$/.exec(input.variantKey);
  if (!recipe) return null;
  const [width, height] = recipe[1].split('x').map(Number);
  return { width, height, exact: true };
}

export function validVariantInput(input: MediaDeliveryVariantInput): boolean {
  return uuidPattern.test(input.assetId) && ['hero', 'ingredient', 'step'].includes(input.kind)
    && deliveryVariantDimensions(input) !== null
    && input.rendererVersion === mediaDeliveryRendererVersion
    && input.sourcePathname.length <= 1000 && /^ai\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)$/.test(input.sourcePathname)
    && !input.sourcePathname.split('/').some(part => !part || part === '.' || part === '..');
}

export function deliveryVariantKey(input: MediaDeliveryVariantInput): string {
  if (!validVariantInput(input)) throw new Error('Invalid media delivery variant identity');
  // ai_asset rejects updates/deletes in PostgreSQL. The immutable logical source
  // binding allows a hit to avoid downloading the full editing master again.
  return sha256(JSON.stringify([input.assetId, input.sourcePathname, input.kind, input.variantKey, input.rendererVersion]));
}

export function deliveryVariantPath(record: Pick<MediaDeliveryVariantRecord, 'rendererVersion' | 'sourceSha256' | 'kind' | 'contentSha256'>): string {
  if (record.rendererVersion !== mediaDeliveryRendererVersion || !digestPattern.test(record.sourceSha256)
    || !digestPattern.test(record.contentSha256) || !['hero', 'ingredient', 'step'].includes(record.kind)) throw new Error('Invalid media variant pathname');
  // The output digest also deduplicates requested widths above the source width:
  // withoutEnlargement may produce exactly the same bytes for both requests.
  return `media-variants/${record.rendererVersion}/${record.sourceSha256}/${record.kind}/${record.contentSha256}.webp`;
}

export function validVariantRecord(record: MediaDeliveryVariantRecord, input: MediaDeliveryVariantInput): boolean {
  try {
    const dimensions = deliveryVariantDimensions(input);
    return validVariantInput(record) && record.key === deliveryVariantKey(input) && record.key === deliveryVariantKey(record)
      && digestPattern.test(record.sourceSha256) && digestPattern.test(record.contentSha256)
      && Number.isSafeInteger(record.sourceBytes) && record.sourceBytes > 0 && record.sourceBytes <= maximumDeliverySourceBytes
      && Number.isSafeInteger(record.byteLength) && record.byteLength > 0 && record.byteLength <= maximumDeliveryVariantBytes
      && dimensions !== null && Number.isSafeInteger(record.width) && record.width > 0 && record.width <= dimensions.width
      && Number.isSafeInteger(record.height) && record.height > 0 && record.height <= 3840
      && (!dimensions.exact || record.width === dimensions.width && record.height === dimensions.height)
      && record.width * record.height <= maximumPixels && record.blobPathname === deliveryVariantPath(record);
  } catch { return false; }
}

export async function verifyDeliveryVariant(record: MediaDeliveryVariantRecord, bytes: Buffer): Promise<DeliveryPhoto> {
  if (!bytes.length || bytes.length > maximumDeliveryVariantBytes || bytes.length !== record.byteLength
    || sha256(bytes) !== record.contentSha256 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error('Invalid stored media delivery variant');
  const metadata = await sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
  if (metadata.format !== 'webp' || (metadata.pages ?? 1) !== 1 || metadata.width !== record.width || metadata.height !== record.height) throw new Error('Stored variant dimensions differ');
  return { bytes, width: record.width, height: record.height };
}

/** A private disposable derivative cache. It never authorizes public access. */
export function createDeliveryVariantCache(dependencies: DeliveryVariantCacheDependencies): MediaDeliveryVariantCache {
  async function read(input: MediaDeliveryVariantInput): Promise<DeliveryPhoto | null> {
    if (!validVariantInput(input)) return null;
    try {
      const record = await dependencies.find(input);
      if (!record || !validVariantRecord(record, input)) return null;
      const bytes = await dependencies.readBlob(record.blobPathname, maximumDeliveryVariantBytes);
      if (!bytes) { await dependencies.invalidate?.(record); return null; }
      try { return await verifyDeliveryVariant(record, bytes); }
      catch { await dependencies.invalidate?.(record); return null; }
    } catch { return null; }
  }
  async function write(input: MediaDeliveryVariantInput, source: Buffer, photo: DeliveryPhoto): Promise<boolean> {
    if (!validVariantInput(input) || !source.length || source.length > maximumDeliverySourceBytes) return false;
    try {
      const record: MediaDeliveryVariantRecord = { ...input, key: deliveryVariantKey(input), sourceSha256: sha256(source), sourceBytes: source.length,
        contentSha256: sha256(photo.bytes), byteLength: photo.bytes.length, width: photo.width, height: photo.height, blobPathname: '' };
      record.blobPathname = deliveryVariantPath(record);
      if (!validVariantRecord(record, input)) return false;
      await verifyDeliveryVariant(record, photo.bytes);
      await dependencies.writeOnce(record, photo.bytes);
      const registered = await dependencies.register(record);
      // A concurrent writer may register first. Its immutable receipt must match
      // the exact source binding and a fully verified private WebP object.
      if (!validVariantRecord(registered, input)) return false;
      const stored = await dependencies.readBlob(registered.blobPathname, maximumDeliveryVariantBytes);
      if (!stored) return false;
      await verifyDeliveryVariant(registered, stored);
      return true;
    } catch { return false; }
  }
  return { read, write };
}
