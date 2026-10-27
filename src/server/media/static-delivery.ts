import 'server-only';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { get, put } from '@vercel/blob';
import sharp from 'sharp';
import { mediaDeliveryWidths, type MediaDeliveryWidth } from '@/lib/media-delivery';
import { isLegacyMediaSource } from '@/lib/legacy-media-delivery';
import type { DeliveryPhoto } from './delivery';
import { boundedVariantBytes } from './delivery-variant-store';

export const staticMediaRendererVersion = 'static-webp-delivery-v1';
const maximumSourceBytes = 32 * 1024 * 1024;
const maximumPhotoBytes = 4 * 1024 * 1024;
const maximumReceiptBytes = 4096;
const maximumPixels = 8_500_000;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const recipes = ['1600x1200', '1600x900', '1200x1200', '1200x630', '1000x1500'];
export type StaticMediaTarget = `responsive:${MediaDeliveryWidth}` | `recipe:${string}`;
type Receipt = { rendererVersion: string; sourceSha256: string; target: string; contentSha256: string; byteLength: number; width: number; height: number };
type Dependencies = {
  readSource(src: string): Promise<Buffer>;
  readBlob(pathname: string, maximum: number, contentType: string, fresh: boolean): Promise<Buffer | null>;
  putBlob(pathname: string, bytes: Buffer, contentType: string): Promise<void>;
};

/** Only files already exposed by public/images can enter the public static route. */
export function isPublicStaticImage(src: string): boolean {
  return isLegacyMediaSource(src);
}

export async function readPublicStaticImage(src: string, directory = path.join(process.cwd(), 'public/images')): Promise<Buffer> {
  if (!isPublicStaticImage(src)) throw new Error('Invalid public image path');
  const root = await realpath(directory);
  const target = await realpath(path.join(root, src.slice('/images/'.length)));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Public image leaves its directory');
  const file = await stat(target);
  if (!file.isFile() || file.size < 1 || file.size > maximumSourceBytes) throw new Error('Invalid public image size');
  const bytes = await readFile(target);
  assertSource(bytes);
  return bytes;
}

function assertSource(source: Buffer) {
  const png = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = source[0] === 255 && source[1] === 216 && source[2] === 255;
  const webp = source.subarray(0, 4).toString('ascii') === 'RIFF' && source.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!source.length || source.length > maximumSourceBytes || !(png || jpeg || webp)) throw new Error('Invalid static raster source');
}

function targetDimensions(target: string): { width: number; height?: number } | null {
  const responsive = /^responsive:(\d+)$/.exec(target);
  if (responsive && mediaDeliveryWidths.some(width => String(width) === responsive[1])) return { width: Number(responsive[1]) };
  if (target.startsWith('recipe:') && recipes.includes(target.slice(7))) {
    const [width, height] = target.slice(7).split('x').map(Number); return { width, height };
  }
  return null;
}

function prefix(sourceSha256: string) { return `media-variants/${staticMediaRendererVersion}/${sourceSha256}`; }
function receiptPath(sourceSha256: string, target: string) { return `${prefix(sourceSha256)}/${target.replace(':', '-')}.json`; }
function pixelPath(receipt: Receipt) { return `${prefix(receipt.sourceSha256)}/pixels/${receipt.contentSha256}.webp`; }

function validReceipt(value: unknown, sourceSha256: string, target: string): value is Receipt {
  if (!value || typeof value !== 'object') return false;
  const item = value as Receipt, size = targetDimensions(target);
  return Boolean(size && item.rendererVersion === staticMediaRendererVersion && item.sourceSha256 === sourceSha256
    && item.target === target && hashPattern.test(item.contentSha256) && Number.isSafeInteger(item.byteLength)
    && item.byteLength > 0 && item.byteLength <= maximumPhotoBytes && Number.isSafeInteger(item.width)
    && Number.isSafeInteger(item.height) && item.width > 0 && item.width <= size.width && item.height > 0
    && item.height <= 3840 && item.width * item.height <= maximumPixels
    && (!size.height || item.width === size.width && item.height === size.height));
}

async function verifyPhoto(receipt: Receipt, bytes: Buffer): Promise<DeliveryPhoto> {
  if (bytes.length !== receipt.byteLength || bytes.length > maximumPhotoBytes || digest(bytes) !== receipt.contentSha256
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error('Invalid static variant receipt');
  const info = await sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
  if (info.format !== 'webp' || (info.pages ?? 1) !== 1 || info.width !== receipt.width || info.height !== receipt.height) throw new Error('Static variant dimensions differ');
  return { bytes, width: receipt.width, height: receipt.height };
}

/** Full atlas/canvas, no crops or enlargement; CSS keeps choosing its original tile. */
export async function renderStaticMediaWidth(source: Buffer, width: MediaDeliveryWidth): Promise<DeliveryPhoto> {
  assertSource(source);
  if (!mediaDeliveryWidths.includes(width)) throw new Error('Unsupported static image width');
  const image = sharp(source, { limitInputPixels: maximumPixels, failOn: 'error' });
  const info = await image.metadata();
  if (!info.width || !info.height || (info.pages ?? 1) !== 1 || !['png', 'jpeg', 'webp'].includes(info.format ?? '')) throw new Error('Invalid static image');
  const rendered = await image.rotate().resize({ width, withoutEnlargement: true })
    .webp({ quality: 88, alphaQuality: 100, exact: true, effort: 4 }).toBuffer({ resolveWithObject: true });
  if (rendered.data.length > maximumPhotoBytes) throw new Error('Static delivery exceeds its bound');
  return { bytes: rendered.data, width: rendered.info.width, height: rendered.info.height };
}

/** Source-addressed receipts survive deployments without inventing AI asset records. */
export function createStaticMediaDelivery(dependencies: Dependencies) {
  const inflight = new Map<string, Promise<DeliveryPhoto>>();
  async function read(sourceSha256: string, target: string, fresh = false): Promise<DeliveryPhoto | null> {
    const bytes = await dependencies.readBlob(receiptPath(sourceSha256, target), maximumReceiptBytes, 'application/json', fresh);
    if (!bytes) return null;
    const receipt: unknown = JSON.parse(bytes.toString('utf8'));
    if (!validReceipt(receipt, sourceSha256, target)) throw new Error('Foreign static variant receipt');
    const pixels = await dependencies.readBlob(pixelPath(receipt), maximumPhotoBytes, 'image/webp', fresh);
    if (!pixels) throw new Error('Static variant pixels unavailable');
    return verifyPhoto(receipt, pixels);
  }
  async function write(sourceSha256: string, target: string, photo: DeliveryPhoto): Promise<DeliveryPhoto> {
    const receipt: Receipt = { rendererVersion: staticMediaRendererVersion, sourceSha256, target,
      contentSha256: digest(photo.bytes), byteLength: photo.bytes.length, width: photo.width, height: photo.height };
    if (!validReceipt(receipt, sourceSha256, target)) throw new Error('Invalid rendered static variant');
    await verifyPhoto(receipt, photo.bytes);
    const pixelsPath = pixelPath(receipt);
    // A rejected/uncertain conditional create is successful only with a verified
    // readback. No overwrite or deletion can turn corruption into trusted bytes.
    let failure: unknown;
    try { await dependencies.putBlob(pixelsPath, photo.bytes, 'image/webp'); } catch (error) { failure = error; }
    const saved = await dependencies.readBlob(pixelsPath, maximumPhotoBytes, 'image/webp', true);
    if (!saved) throw failure ?? new Error('Static pixels were not saved');
    await verifyPhoto(receipt, saved);
    if (!saved.equals(photo.bytes)) throw new Error('Immutable static image conflict');
    try { await dependencies.putBlob(receiptPath(sourceSha256, target), Buffer.from(JSON.stringify(receipt)), 'application/json'); } catch (error) { failure = error; }
    const winner = await read(sourceSha256, target, true);
    if (!winner) throw failure ?? new Error('Static receipt was not saved');
    return winner;
  }
  async function variant(src: string, target: StaticMediaTarget, render: (source: Buffer) => Promise<DeliveryPhoto>): Promise<DeliveryPhoto> {
    if (!isPublicStaticImage(src) || !targetDimensions(target)) throw new Error('Invalid static delivery request');
    const source = await dependencies.readSource(src); assertSource(source);
    const sha = digest(source), key = receiptPath(sha, target);
    const existing = inflight.get(key); if (existing) return existing;
    const work = (async () => {
      try { const ready = await read(sha, target); if (ready) return ready; } catch { /* Keep the public source usable during cache outages/corruption. */ }
      const photo = await render(source);
      try { return await write(sha, target, photo); } catch { return photo; }
    })();
    inflight.set(key, work);
    try { return await work; } finally { if (inflight.get(key) === work) inflight.delete(key); }
  }
  return { variant, responsive: (src: string, width: MediaDeliveryWidth) => variant(src, `responsive:${width}`, source => renderStaticMediaWidth(source, width)) };
}

const media = createStaticMediaDelivery({
  readSource: readPublicStaticImage,
  async readBlob(pathname, maximum, contentType, fresh) {
    let result = await get(pathname, { access: 'private', useCache: !fresh, abortSignal: AbortSignal.timeout(15_000) });
    // A first request can leave a cached 404 while another process publishes the
    // immutable receipt. Confirm origin before paying for another transformation.
    if ((!result || result.statusCode !== 200) && !fresh) result = await get(pathname, {
      access: 'private', useCache: false, abortSignal: AbortSignal.timeout(15_000),
    });
    if (!result || result.statusCode !== 200) return null;
    if (result.blob.contentType.split(';')[0].trim().toLowerCase() !== contentType) {
      await result.stream.cancel().catch(() => {}); throw new Error('Invalid static cache MIME');
    }
    return boundedVariantBytes(result.stream, maximum, result.blob.size);
  },
  async putBlob(pathname, bytes, contentType) {
    await put(pathname, bytes, { access: 'private', contentType, allowOverwrite: false, addRandomSuffix: false,
      cacheControlMaxAge: 365 * 24 * 60 * 60, abortSignal: AbortSignal.timeout(30_000) });
  },
});
export const getStaticMediaWidth = media.responsive;
export const getStaticMediaVariant = media.variant;
