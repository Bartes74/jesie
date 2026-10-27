import { getMediaBlob } from '@/server/media/storage';
import { getAdminSession } from '@/server/auth';
import { getAssetForExecution, isAssetPublic } from '@/server/ai/store';
import { normalizeHeroPresentation } from '@/server/ai/hero-presentation';
import { getPublishedHeroDelivery, publicMediaCacheControl, readBoundedMedia } from '@/server/seo/media';
import { recoverPublicMedia } from '@/server/media/public-recovery';
import { parseMediaDeliveryWidth } from '@/lib/media-delivery';
import { createMediaDeliveryService } from '@/server/media/delivery';
import { mediaDeliveryResponse } from '@/server/media/delivery-response';
import { durableMediaDeliveryVariants } from '@/server/media/delivery-variant-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const missing = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
const deliver = createMediaDeliveryService({
  isPublic: isAssetPublic,
  isAdmin: async headers => Boolean(headers && await getAdminSession(headers)),
  variants: durableMediaDeliveryVariants,
  read: async pathname => {
    let blob = await getMediaBlob(pathname);
    if (!blob || blob.statusCode !== 200) blob = await getMediaBlob(pathname, { useCache: false });
    return blob?.statusCode === 200 ? readBoundedMedia({ stream: blob.stream, size: blob.blob.size, contentType: blob.blob.contentType }) : null;
  },
});

async function readHeroBlob(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024 * 1024) throw new Error('Hero exceeds the image size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/.test(id)) return missing();
    const width = parseMediaDeliveryWidth(new URL(request.url).searchParams);
    if (width === null) return new Response(null, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    const asset = await getAssetForExecution(id);
    if (!asset) return missing();
    if (width !== undefined) {
      const display = await deliver(asset, width, request.headers);
      if (!display) return missing();
      return mediaDeliveryResponse(display, request.headers);
    }
    if (asset.kind === 'hero') {
      const display = await getPublishedHeroDelivery(asset, width);
      if (display) return new Response(display.stream, { headers: {
          'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': publicMediaCacheControl, 'Content-Security-Policy': "default-src 'none'",
          'Content-Disposition': 'inline', ...(display.size ? { 'Content-Length': String(display.size) } : {}),
        } });
    }
    const publicAsset = await isAssetPublic(id);
    if (!publicAsset && !await getAdminSession(request.headers)) return missing();
    let blob = await getMediaBlob(asset.blobPathname);
    // A newly uploaded file can still have an older cached 404. Read origin
    // before declaring a registered, authorized photograph unavailable.
    if (!blob || blob.statusCode !== 200) {
      blob = await getMediaBlob(asset.blobPathname, { useCache: false });
    }
    if (!blob || blob.statusCode !== 200) return missing();
    if (publicAsset && !await isAssetPublic(id)) { await blob.stream.cancel().catch(() => {}); return missing(); }
    let body: BodyInit = blob.stream;
    let contentType = blob.blob.contentType || asset.contentType;
    if (asset.kind === 'hero') {
      const original = await readHeroBlob(blob.stream);
      const display = await normalizeHeroPresentation(original);
      body = new Uint8Array(display?.bytes ?? original);
      if (display) contentType = 'image/png';
    }
    return new Response(body, { headers: {
      'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': publicAsset ? publicMediaCacheControl : 'private, no-store', 'Content-Security-Policy': "default-src 'none'",
      'Content-Disposition': 'inline',
    } });
  } catch (error) {
    try {
      const { id } = await context.params;
      const width = parseMediaDeliveryWidth(new URL(request.url).searchParams);
      if (width !== null) {
        const recovered = await recoverPublicMedia(id, width, error);
        if (recovered) return recovered;
      }
    } catch { /* Corrupt or expired emergency copies fail closed. */ }
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
