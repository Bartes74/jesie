import 'server-only';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { createRecipeMediaService, isStaticRecipeImage, type StoredMedia } from '@/server/seo/media';
import type { MediaDeliveryWidth } from '@/lib/media-delivery';
import { renderMediaDelivery, type DeliveryPhotoKind } from './delivery';
import { isNeonQuotaError, loadPublishedSnapshot } from '@/server/public/published-snapshot';
import { createLocalRecoveryReader, readLocalRecoveredMedia, type LocalRecoveredMedia } from './local-recovery';

export type PublicRecoveryAsset = {
  kind: 'hero' | 'ingredient' | 'step';
  blobPathname: string;
  publicRecipeIds: string[];
};
export type PublicRecoveryRegistry = { assets: Record<string, PublicRecoveryAsset> };
const uuid = /^[a-f0-9-]{36}$/;
const missing = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
// A stale historical publication is never retained by a response cache after its
// fixed capture expiry. Normal database-backed delivery keeps its usual caching.
const recoveryCacheControl = 'public, max-age=0, s-maxage=0, must-revalidate';

function hasPublishedReference(recipe: PublicRecipe, id: string, kind: PublicRecoveryAsset['kind']) {
  const src = `/media/${id}`;
  if (kind === 'hero') return recipe.image === src;
  const images = kind === 'ingredient' ? recipe.photos?.ingredients : recipe.photos?.steps;
  return Object.values(images ?? {}).some(image => image.src === src);
}

async function readStaticPublicImage(src: string) {
  if (!isStaticRecipeImage(src)) throw new Error('Invalid static public image');
  const root = await realpath(path.join(process.cwd(), 'public/images'));
  const target = await realpath(path.join(process.cwd(), 'public', src));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Static public image leaves its directory');
  const file = await lstat(target);
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > 32 * 1024 * 1024) throw new Error('Invalid static public image file');
  return readFile(target);
}

/** Only the exact anonymous public capture can authorize an emergency image. */
export function createPublicMediaRecovery(dependencies: {
  loadSnapshot: () => Promise<PublicRecipe[] | null>;
  loadRegistry: () => Promise<PublicRecoveryRegistry | null>;
  readMedia: (pathname: string) => Promise<LocalRecoveredMedia | null>;
  readStatic?: (src: string) => Promise<Buffer>;
}) {
  async function capture() {
    const recipes = await dependencies.loadSnapshot();
    if (!recipes?.length) return null;
    const registry = await dependencies.loadRegistry();
    if (!registry) return null;
    const recipeMap = new Map(recipes.map(recipe => [recipe.id, recipe]));
    const assetFor = (id: string) => {
      const item = registry.assets[id];
      if (!uuid.test(id) || !item || !item.publicRecipeIds.length
        || !item.publicRecipeIds.every(recipeId => {
          const recipe = recipeMap.get(recipeId);
          return recipe && hasPublishedReference(recipe, id, item.kind);
        })) return null;
      return { id, kind: item.kind, blobPathname: item.blobPathname, recipeId: item.publicRecipeIds[0] };
    };
    const media = createRecipeMediaService({
      persistDerivatives: false,
      publishedRecipe: async id => recipeMap.get(id) ?? null,
      asset: async id => assetFor(id),
      assetPublic: async id => assetFor(id)?.kind === 'hero',
      readStatic: dependencies.readStatic ?? readStaticPublicImage,
      readStored: async pathname => {
        const stored = await dependencies.readMedia(pathname);
        return stored ? { stream: new Response(new Uint8Array(stored.bytes)).body!, size: stored.bytes.length, contentType: stored.contentType } : null;
      },
      writeStored: async () => { throw new Error('Public emergency media never writes a derivative'); },
    });
    return { recipes, assetFor, media };
  }
  async function response(image: StoredMedia | null) {
    if (!image) return missing();
    // Validate the clock again after filesystem reads and image formatting.
    if (!await dependencies.loadSnapshot()) {
      await image.stream.cancel().catch(() => {});
      return null;
    }
    return new Response(image.stream, { headers: {
      'Content-Type': image.contentType ?? 'image/webp', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': recoveryCacheControl, 'Content-Security-Policy': "default-src 'none'",
      'Content-Disposition': 'inline', ...(image.size ? { 'Content-Length': String(image.size) } : {}),
    } });
  }
  return {
    async asset(id: string, width: MediaDeliveryWidth | undefined, error: unknown): Promise<Response | null> {
      if (!isNeonQuotaError(error)) return null;
      const captured = await capture();
      if (!captured) return null;
      const asset = captured.assetFor(id);
      if (!asset) return missing();
      if (width !== undefined) {
        const stored = await dependencies.readMedia(asset.blobPathname);
        if (!stored) return missing();
        const image = await renderMediaDelivery(stored.bytes, asset.kind as DeliveryPhotoKind, width);
        return response({ stream: new Response(new Uint8Array(image.bytes)).body!, size: image.bytes.length, contentType: 'image/webp' });
      }
      if (asset.kind === 'hero') return response(await captured.media.publicHeroDelivery(asset));
      const stored = await dependencies.readMedia(asset.blobPathname);
      return response(stored ? { stream: new Response(new Uint8Array(stored.bytes)).body!, size: stored.bytes.length, contentType: stored.contentType } : null);
    },
    async variant(id: string, version: string, filename: string, error: unknown): Promise<Response | null> {
      if (!isNeonQuotaError(error)) return null;
      const captured = await capture();
      if (!captured) return null;
      return response(await captured.media.recipeImage(id, version, filename));
    },
  };
}

const capturedAt = '2026-10-13T15:50:52Z';
const expiresAt = '2026-10-14T15:50:52Z';
const sourceSha256 = 'ec024ae426c2d1ea8a14495e9df375895648186494082898e5e61ef95319604b';
// This pin binds all 197 IDs, kinds, source paths and published recipe references.
const registrySha256 = 'cf44cbe649fad705779b8b972f8d8e63e08c6c7d7a924e0cf6b357a9186110a6';
let bundledRegistry: Promise<unknown> | undefined;
async function loadRegistry(): Promise<PublicRecoveryRegistry | null> {
  try {
    const value = await (bundledRegistry ??= import('../../../private-data/public-recovery/media.json').then(module => module.default));
    if (createHash('sha256').update(JSON.stringify(value)).digest('hex') !== registrySha256) return null;
    const input = value as { version?: unknown; capturedAt?: unknown; expiresAt?: unknown; sourceSha256?: unknown; assets?: Record<string, PublicRecoveryAsset> };
    if (input.version !== 1 || input.capturedAt !== capturedAt || input.expiresAt !== expiresAt || input.sourceSha256 !== sourceSha256 || !input.assets
      || Object.keys(input.assets).length !== 197) return null;
    return { assets: input.assets };
  } catch { return null; }
}
const readQuotaRecoveredMedia = createLocalRecoveryReader({ rootDirectory: path.join(process.cwd(), 'private-media', 'quota-public-recovery') });
const recovery = createPublicMediaRecovery({
  loadSnapshot: loadPublishedSnapshot,
  loadRegistry,
  // Reuse the already traced public recovery copy without duplicating its bytes.
  readMedia: async pathname => await readLocalRecoveredMedia(pathname) ?? readQuotaRecoveredMedia(pathname),
});
export const recoverPublicMedia = recovery.asset;
export const recoverPublicRecipeVariant = recovery.variant;
