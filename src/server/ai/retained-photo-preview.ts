import 'server-only';
import { getJobForExecution } from './store';
import { AiError } from './errors';
import { failedHeroSourcePrefix, heroCutoutModel, isRecoverableHeroSource, type FailedHeroSource } from './image-actions';
import { getMediaBlob } from '@/server/media/storage';

const maximumBytes = 32 * 1024 * 1024;
type PhotoBlob = { statusCode: number; stream: ReadableStream<Uint8Array>; blob: { size: number; contentType: string } };
type Dependencies = {
  job(id: string): Promise<FailedHeroSource>;
  blob(pathname: string): Promise<PhotoBlob | null>;
};
const dependencies: Dependencies = {
  job: getJobForExecution,
  async blob(pathname) {
    const blob = await getMediaBlob(pathname, { useCache: false });
    return blob?.statusCode === 200 ? blob : null;
  },
};
const unavailable = () => new AiError(404, 'PHOTO_PREVIEW_UNAVAILABLE', 'Zachowany oryginał zdjęcia jest obecnie niedostępny. Odśwież podgląd później.');

async function boundedPhoto(blob: PhotoBlob): Promise<Buffer> {
  const reader = blob.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (!Number.isSafeInteger(blob.blob.size) || blob.blob.size < 0 || blob.blob.size > maximumBytes) throw unavailable();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw unavailable();
      chunks.push(next.value);
    }
    if (!size || blob.blob.size > 0 && size !== blob.blob.size) throw unavailable();
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Private read of a completed photograph. Never contacts the generator or writes an archive. */
export async function readRetainedPhotoPreview(id: string, storage: Dependencies = dependencies): Promise<{ bytes: Buffer; contentType: string }> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw unavailable();
  const requested = await storage.job(id);
  let source = requested;
  if (requested.kind === 'hero' && requested.provider === 'fal' && requested.model === heroCutoutModel) {
    const marker = requested.input?.recipe.image;
    const sourceId = marker?.startsWith(failedHeroSourcePrefix) ? marker.slice(failedHeroSourcePrefix.length) : '';
    if (!/^[a-f0-9-]{36}$/i.test(sourceId)) throw unavailable();
    source = await storage.job(sourceId);
  }
  if (!isRecoverableHeroSource(source, requested.recipeId)) throw unavailable();
  for (const extension of ['webp', 'png']) {
    const blob = await storage.blob(`ai/${source.id}/recovered-original.${extension}`);
    if (!blob) continue;
    // Media compaction may resolve a legacy PNG pathname to a verified WebP.
    const contentType = blob.blob.contentType.split(';')[0].trim().toLowerCase();
    if (blob.statusCode !== 200 || !['image/webp', 'image/png'].includes(contentType)) {
      await blob.stream.cancel().catch(() => {});
      throw unavailable();
    }
    return { bytes: await boundedPhoto(blob), contentType };
  }
  throw unavailable();
}
