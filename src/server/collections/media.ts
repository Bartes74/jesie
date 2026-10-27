import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { put } from '@vercel/blob';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { getMediaBlob } from '@/server/media/storage';
import { readBounded } from '@/server/ai/image-provider';
import { collectionAssets } from './theme-schema';
import { CollectionError } from './errors';
import type { CollectionThemeAsset } from '@/lib/collections';
import type { Localised } from '@/lib/recipes';

export const collectionAssetPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const collectionAssetPath = (id: string) => `media/collections/${id}.webp`;
export const inspirationMaximumBytes = 10 * 1024 * 1024;

export async function normalizeCollectionImage(bytes: Buffer, inspiration = false) {
  const maximum = inspiration ? inspirationMaximumBytes : 32 * 1024 * 1024;
  if (!bytes.length || bytes.length > maximum) throw new CollectionError(413, 'IMAGE_TOO_LARGE', 'Grafika przekracza dopuszczalny rozmiar.');
  try {
    const image = sharp(bytes, { limitInputPixels: 24_000_000, animated: false, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new CollectionError(422, 'IMAGE_FORMAT', 'Wybierz nieruchomy obraz JPEG, PNG lub WebP.');
    const output = await image.rotate().resize({ width: inspiration ? 1600 : 1800, height: inspiration ? 1600 : 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
    return { bytes: output.data, width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError(422, 'IMAGE_FORMAT', 'Nie udało się odczytać obrazu. Wybierz poprawny JPEG, PNG lub WebP o wielkości do 24 megapikseli.');
  }
}

export async function saveCollectionAsset(input: { collectionId: string; kind: 'inspiration' | 'hero' | 'atmosphere'; bytes: Buffer; id?: string; generationId?: string }) {
  const id = input.id ?? randomUUID();
  const [existing] = await getDb().select().from(collectionAssets).where(eq(collectionAssets.id, id));
  if (existing) {
    if (existing.collectionId !== input.collectionId || existing.kind !== input.kind) throw new Error('COLLECTION_ASSET_IDENTITY');
    return existing;
  }
  const image = await normalizeCollectionImage(input.bytes, input.kind === 'inspiration');
  const pathname = collectionAssetPath(id);
  const sha256 = createHash('sha256').update(image.bytes).digest('hex');
  try { await put(pathname, image.bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'image/webp' }); }
  catch (error) {
    const existingBlob = await getMediaBlob(pathname, { useCache: false });
    if (!existingBlob || existingBlob.statusCode !== 200) throw error;
    const recovered = await readBounded(existingBlob.stream, 32 * 1024 * 1024);
    if (createHash('sha256').update(recovered).digest('hex') !== sha256) throw error;
  }
  const [row] = await getDb().insert(collectionAssets).values({ id, collectionId: input.collectionId, generationId: input.generationId ?? null,
    kind: input.kind, blobPathname: pathname, sha256, width: image.width, height: image.height, contentType: 'image/webp' }).onConflictDoNothing().returning();
  return row ?? (await getDb().select().from(collectionAssets).where(eq(collectionAssets.id, id)))[0];
}
export function themeAsset(row: typeof collectionAssets.$inferSelect, alt: Localised): CollectionThemeAsset {
  return { assetId: row.id, src: `/media/collections/${row.id}`, width: row.width, height: row.height, alt };
}
export async function readCollectionAsset(collectionId: string, assetId: string, kind?: 'inspiration' | 'hero' | 'atmosphere') {
  if (!collectionAssetPattern.test(assetId)) return null;
  const [row] = await getDb().select().from(collectionAssets).where(and(eq(collectionAssets.id, assetId), eq(collectionAssets.collectionId, collectionId)));
  if (!row || kind && row.kind !== kind) return null;
  const blob = await getMediaBlob(row.blobPathname, { useCache: false });
  if (!blob || blob.statusCode !== 200) throw new CollectionError(503, 'IMAGE_UNAVAILABLE', 'Grafika jest chwilowo niedostępna.');
  return { row, bytes: await readBounded(blob.stream, 32 * 1024 * 1024) };
}
