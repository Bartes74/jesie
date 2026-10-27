import 'server-only';
import { randomUUID } from 'node:crypto';
import { get, put } from '@vercel/blob';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { mediaDeliveryWidths, type MediaDeliveryWidth } from '@/lib/media-delivery';
import { getMediaBlob } from './storage';
import type { DeliveryAsset, DeliveryPhoto } from './delivery';
import { createDeliveryVariantCache, deliveryVariantKey, deliveryVariantDimensions,
  mediaDeliveryRendererVersion, mediaVariantInput, validVariantInput, validVariantRecord, verifyDeliveryVariant,
  maximumDeliverySourceBytes, maximumDeliveryVariantBytes,
  type MediaDeliveryVariantInput, type MediaDeliveryVariantRecord, type MediaDeliveryVariantCache } from './delivery-variant-cache';

type Database = Pick<ReturnType<typeof getDb>, 'execute'>;
type Asset = DeliveryAsset & { width: number; height: number };
const leaseSeconds = 180;
const projection = sql`cache_key AS key, asset_id AS "assetId", source_pathname AS "sourcePathname", kind,
  variant_key AS "variantKey", renderer_version AS "rendererVersion", source_sha256 AS "sourceSha256",
  source_bytes AS "sourceBytes", blob_pathname AS "blobPathname", content_sha256 AS "contentSha256",
  byte_length AS "byteLength", width, height`;

/** Only short atomic statements acquire a claim. Blob I/O and Sharp run outside transactions. */
export function createMediaVariantRepository(database: () => Database = getDb) {
  return {
    async find(input: MediaDeliveryVariantInput): Promise<MediaDeliveryVariantRecord | null> {
      const result = await database().execute(sql`SELECT ${projection} FROM media_delivery_variant
        WHERE cache_key=${deliveryVariantKey(input)} AND status='ready'`);
      return result.rows[0] as MediaDeliveryVariantRecord | undefined ?? null;
    },
    async claim(input: MediaDeliveryVariantInput): Promise<string | null> {
      const token = randomUUID();
      const result = await database().execute(sql`INSERT INTO media_delivery_variant
        (cache_key,asset_id,source_pathname,kind,variant_key,renderer_version,status,lease_token,lease_until,attempts)
        SELECT ${deliveryVariantKey(input)},a.id,a.blob_pathname,a.kind,${input.variantKey},${input.rendererVersion},
          'rendering',${token}::uuid,clock_timestamp()+make_interval(secs=>${leaseSeconds}),1
        FROM ai_asset a WHERE a.id=${input.assetId} AND a.blob_pathname=${input.sourcePathname} AND a.kind=${input.kind}
        ON CONFLICT(cache_key) DO UPDATE SET status='rendering',lease_token=EXCLUDED.lease_token,
          lease_until=EXCLUDED.lease_until,attempts=media_delivery_variant.attempts+1,error_code=NULL,updated_at=clock_timestamp()
        WHERE (media_delivery_variant.status='pending' OR media_delivery_variant.status='rendering' AND media_delivery_variant.lease_until<=clock_timestamp())
          AND media_delivery_variant.asset_id=EXCLUDED.asset_id AND media_delivery_variant.source_pathname=EXCLUDED.source_pathname
          AND media_delivery_variant.kind=EXCLUDED.kind AND media_delivery_variant.variant_key=EXCLUDED.variant_key
          AND media_delivery_variant.renderer_version=EXCLUDED.renderer_version RETURNING lease_token`);
      return result.rows.length ? token : null;
    },
    async complete(record: MediaDeliveryVariantRecord, token: string): Promise<MediaDeliveryVariantRecord | null> {
      const result = await database().execute(sql`UPDATE media_delivery_variant v SET status='ready',lease_token=NULL,lease_until=NULL,
          source_sha256=${record.sourceSha256},source_bytes=${record.sourceBytes},blob_pathname=${record.blobPathname},
          content_sha256=${record.contentSha256},byte_length=${record.byteLength},width=${record.width},height=${record.height},
          verified_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=NULL
        WHERE cache_key=${record.key} AND status='rendering' AND lease_token=${token}::uuid AND lease_until>clock_timestamp()
          AND EXISTS(SELECT 1 FROM ai_asset a WHERE a.id=v.asset_id AND a.blob_pathname=v.source_pathname AND a.kind=v.kind)
        RETURNING ${projection}`);
      return result.rows[0] as MediaDeliveryVariantRecord | undefined ?? null;
    },
    async fail(input: MediaDeliveryVariantInput, token: string) {
      await database().execute(sql`UPDATE media_delivery_variant SET status='pending',lease_token=NULL,lease_until=NULL,
        error_code='VARIANT_UNAVAILABLE',updated_at=clock_timestamp() WHERE cache_key=${deliveryVariantKey(input)}
        AND status='rendering' AND lease_token=${token}::uuid`);
    },
    async invalidate(record: MediaDeliveryVariantRecord) {
      await database().execute(sql`UPDATE media_delivery_variant SET status='pending',error_code='VARIANT_INVALID',updated_at=clock_timestamp()
        WHERE cache_key=${record.key} AND status='ready' AND blob_pathname=${record.blobPathname} AND content_sha256=${record.contentSha256}`);
    },
    async asset(id: string): Promise<Asset | null> {
      const result = await database().execute(sql`SELECT id,kind,blob_pathname AS "blobPathname",width,height FROM ai_asset WHERE id=${id}`);
      return result.rows[0] as Asset | undefined ?? null;
    },
    pending(options: { afterAssetId?: string; limit?: number } = {}) {
      return listPendingWithDatabase(database(), options);
    },
  };
}

export async function boundedVariantBytes(stream: ReadableStream<Uint8Array>, maximum: number, declaredSize?: number): Promise<Buffer> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  // Blob GET reports size=0 when a chunked/compressed response omits
  // Content-Length. That is an unknown transport length, never proof that a
  // photograph is empty. The stream bound and immutable receipt still apply.
  const expectedSize = declaredSize === 0 ? undefined : declaredSize;
  try {
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximum)) throw new Error('Media variant size exceeds its bound');
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error('Media variant stream exceeds its bound');
      chunks.push(next.value);
    }
    if (!total || expectedSize !== undefined && total !== expectedSize) throw new Error('Media variant size differs');
    return Buffer.concat(chunks, total);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

type VariantBlob = { stream: ReadableStream<Uint8Array>; size: number; contentType: string };
type BlobDependencies = {
  read(pathname: string, useCache: boolean): Promise<VariantBlob | null>;
  put(pathname: string, bytes: Buffer, options: { access: 'private'; contentType: 'image/webp'; addRandomSuffix: false; allowOverwrite: false; cacheControlMaxAge: number }): Promise<void>;
};
const blobDependencies: BlobDependencies = {
  async read(pathname, useCache) {
    const result = await get(pathname, { access: 'private', useCache, abortSignal: AbortSignal.timeout(15_000) });
    return result?.statusCode === 200 ? { stream: result.stream, size: result.blob.size, contentType: result.blob.contentType } : null;
  },
  async put(pathname, bytes, options) {
    await put(pathname, bytes, { ...options, abortSignal: AbortSignal.timeout(30_000) });
  },
};

export function createVariantBlobStorage(dependencies: BlobDependencies = blobDependencies) {
  async function read(pathname: string, maximum: number, useCache = true): Promise<Buffer | null> {
    if (!/^media-variants\/webp-delivery-v1\/[a-f0-9]{64}\/(?:hero|ingredient|step)\/[a-f0-9]{64}\.webp$/.test(pathname)) throw new Error('Invalid private variant path');
    let result = await dependencies.read(pathname, useCache);
    if (!result && useCache) result = await dependencies.read(pathname, false);
    if (!result) return null;
    if (result.contentType !== 'image/webp') { await result.stream.cancel().catch(() => {}); throw new Error('Invalid media variant content type'); }
    return boundedVariantBytes(result.stream, maximum, result.size);
  }
  return {
    read,
    async writeOnce(record: MediaDeliveryVariantRecord, bytes: Buffer): Promise<void> {
      if (!validVariantRecord(record, record)) throw new Error('Invalid immutable variant receipt');
      await verifyDeliveryVariant(record, bytes);
      // The provider performs atomic create-if-absent, not a racy HEAD/PUT pair.
      // A transport failure may hide an accepted write: a fresh verified GET also
      // handles that case without ever issuing an overwrite or deleting a file.
      let failure: unknown;
      try { await dependencies.put(record.blobPathname, bytes, { access: 'private', contentType: 'image/webp',
        addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 365 * 24 * 60 * 60 }); } catch (error) { failure = error; }
      const saved = await read(record.blobPathname, maximumDeliveryVariantBytes, false);
      if (!saved) throw failure ?? new Error('Uploaded media variant is unavailable');
      await verifyDeliveryVariant(record, saved);
      if (!saved.equals(bytes)) throw new Error('Immutable media variant conflict');
    },
  };
}

const repository = createMediaVariantRepository();
const blobStorage = createVariantBlobStorage();
const readCache = createDeliveryVariantCache({ find: repository.find, invalidate: repository.invalidate,
  readBlob: blobStorage.read, writeOnce: blobStorage.writeOnce,
  register: async () => { throw new Error('A variant registration requires a live fenced claim'); } });

async function saveClaimedVariant(input: MediaDeliveryVariantInput, token: string, source: Buffer, photo: DeliveryPhoto) {
  const cache = createDeliveryVariantCache({ find: repository.find, invalidate: repository.invalidate,
    readBlob: blobStorage.read, writeOnce: blobStorage.writeOnce,
    register: async record => {
      const completed = await repository.complete(record, token);
      if (!completed) throw new Error('Media variant lease was superseded');
      return completed;
    } });
  const saved = await cache.write(input, source, photo);
  if (!saved) await repository.fail(input, token).catch(() => {});
  return saved;
}

export const durableMediaDeliveryVariants: MediaDeliveryVariantCache = {
  read: readCache.read,
  async write(input, source, photo) {
    try {
      const token = await repository.claim(input); if (!token) return Boolean(await readCache.read(input));
      return await saveClaimedVariant(input, token, source, photo);
    } catch { return false; }
  },
  async prepare(input, load) {
    let token: string | null = null;
    try {
      const ready = await readCache.read(input); if (ready) return ready;
      token = await repository.claim(input); if (!token) return readCache.read(input);
      const loaded = await load();
      if (!loaded) { await repository.fail(input, token); return null; }
      await saveClaimedVariant(input, token, loaded.source, loaded.photo);
      return loaded.photo;
    } catch { if (token) await repository.fail(input, token).catch(() => {}); return null; }
  },
};

export type MediaDeliveryWarmInput = MediaDeliveryVariantInput & { sourceIdentity: string };
export type MediaDeliveryWarmResult = { status: 'ready' | 'busy' | 'unavailable' | 'stale'; sourceIdentity: string; variantKey: string; bytes: number };

function declaredVariantKeys(kind: string): string[] {
  const responsive = mediaDeliveryWidths.filter(width => kind !== 'ingredient' || width <= 1280)
    .map(width => `responsive:${width}`);
  return kind === 'hero' ? [...responsive, 'hero:full', 'recipe:1600x1200', 'recipe:1600x900', 'recipe:1200x1200', 'recipe:1200x630', 'recipe:1000x1500'] : responsive;
}

export function declaredMediaVariants(asset: DeliveryAsset): MediaDeliveryVariantInput[] {
  return declaredVariantKeys(asset.kind).map(key => mediaVariantInput(asset, key));
}

/** Cursor is over immutable assets, including retained history and private drafts. */
export async function listPendingMediaDeliveryVariants(options: { afterAssetId?: string; limit?: number } = {}): Promise<{ inputs: MediaDeliveryWarmInput[]; nextAssetId: string | null }> {
  return listPendingWithDatabase(getDb(), options);
}

async function listPendingWithDatabase(database: Database, options: { afterAssetId?: string; limit?: number }): Promise<{ inputs: MediaDeliveryWarmInput[]; nextAssetId: string | null }> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
  if (!Number.isSafeInteger(limit) || options.afterAssetId !== undefined && !/^[a-f0-9-]{36}$/.test(options.afterAssetId)) throw new Error('Invalid media variant cursor');
  const targets = ['hero', 'ingredient', 'step'].flatMap(kind => declaredVariantKeys(kind).map(key => sql`(${kind},${key})`));
  // Filter before LIMIT so complete historical assets never consume a worker
  // page. An extra on-demand target cannot stand in for a missing declared one.
  // The unique identity index serves each exact source/kind/renderer lookup.
  const assets = await database.execute(sql`SELECT a.id,a.kind,a.blob_pathname AS "blobPathname",a.width,a.height FROM ai_asset a
    WHERE a.id>${options.afterAssetId ?? ''} AND a.kind IN ('hero','ingredient','step')
      AND EXISTS(SELECT 1 FROM (VALUES ${sql.join(targets, sql`,`)}) AS target(kind,variant_key)
        WHERE target.kind=a.kind AND NOT EXISTS(SELECT 1 FROM media_delivery_variant v
          WHERE v.asset_id=a.id AND v.source_pathname=a.blob_pathname AND v.kind=a.kind
            AND v.variant_key=target.variant_key AND v.renderer_version=${mediaDeliveryRendererVersion} AND v.status='ready'))
    ORDER BY a.id LIMIT ${limit}`);
  const rows = assets.rows as Asset[];
  if (!rows.length) return { inputs: [], nextAssetId: null };
  const ready = await database.execute(sql`SELECT cache_key FROM media_delivery_variant WHERE status='ready'
    AND renderer_version=${mediaDeliveryRendererVersion} AND asset_id IN (${sql.join(rows.map(row => sql`${row.id}`), sql`,`)})`);
  const readyKeys = new Set(ready.rows.map(row => String(row.cache_key)));
  const inputs = rows.flatMap(asset => declaredMediaVariants(asset)).filter(input => !readyKeys.has(deliveryVariantKey(input)))
    .map(input => ({ ...input, sourceIdentity: deliveryVariantKey(input) }));
  return { inputs, nextAssetId: rows.length === limit ? rows.at(-1)!.id : null };
}

export async function readDeliverySource(pathname: string): Promise<Buffer | null> {
  let source = await getMediaBlob(pathname);
  if (!source || source.statusCode !== 200) source = await getMediaBlob(pathname, { useCache: false });
  if (!source || source.statusCode !== 200) return null;
  return boundedVariantBytes(source.stream, maximumDeliverySourceBytes, source.blob.size);
}

export async function renderDeclaredMediaVariant(input: MediaDeliveryVariantInput, source: Buffer): Promise<DeliveryPhoto> {
  const dimensions = deliveryVariantDimensions(input);
  if (!validVariantInput(input) || !dimensions) throw new Error('Unsupported media delivery target');
  if (input.variantKey.startsWith('responsive:')) {
    const { renderMediaDelivery } = await import('./delivery');
    return renderMediaDelivery(source, input.kind, dimensions.width as MediaDeliveryWidth);
  }
  const { renderRecipeImageVariant, renderPublishedHeroMaster } = await import('@/server/seo/media');
  if (input.variantKey === 'hero:full') return renderPublishedHeroMaster(source);
  const bytes = await renderRecipeImageVariant(source, { width: dimensions.width, height: dimensions.height! });
  return { bytes, width: dimensions.width, height: dimensions.height! };
}

/** Worker-only preparation. It creates private derivatives, never a publication or AI job. */
async function warmVariant(input: MediaDeliveryWarmInput, readSource: typeof readDeliverySource): Promise<MediaDeliveryWarmResult> {
  const result = (status: MediaDeliveryWarmResult['status'], bytes = 0): MediaDeliveryWarmResult => ({ status, sourceIdentity: input.sourceIdentity, variantKey: input.variantKey, bytes });
  if (!validVariantInput(input) || input.sourceIdentity !== deliveryVariantKey(input)) return result('stale');
  let token: string | null = null;
  try {
    const asset = await repository.asset(input.assetId);
    if (!asset || asset.blobPathname !== input.sourcePathname || asset.kind !== input.kind) return result('stale');
    const ready = await readCache.read(input); if (ready) return result('ready', ready.bytes.length);
    token = await repository.claim(input); if (!token) return result('busy');
    const source = await readSource(input.sourcePathname);
    if (!source) { await repository.fail(input, token); return result('unavailable'); }
    const photo = await renderDeclaredMediaVariant(input, source);
    return result(await saveClaimedVariant(input, token, source, photo) ? 'ready' : 'unavailable', photo.bytes.length);
  } catch { if (token) await repository.fail(input, token).catch(() => {}); return result('unavailable'); }
}

export async function warmMediaDeliveryVariant(input: MediaDeliveryWarmInput): Promise<MediaDeliveryWarmResult> {
  return warmVariant(input, readDeliverySource);
}

/** A bounded worker batch reuses one source read per asset and renders at most two images concurrently. */
export async function warmMediaDeliveryVariants(inputs: MediaDeliveryWarmInput[], dependencies: { warm?: typeof warmVariant; readSource?: typeof readDeliverySource } = {}): Promise<MediaDeliveryWarmResult[]> {
  if (inputs.length > 64) throw new Error('A media warm batch is too large');
  const groups = new Map<string, MediaDeliveryWarmInput[]>();
  for (const input of inputs) {
    if (!validVariantInput(input) || input.sourceIdentity !== deliveryVariantKey(input)) throw new Error('Invalid media warm input');
    const key = JSON.stringify([input.assetId, input.sourcePathname]);
    groups.set(key, [...(groups.get(key) ?? []), input]);
  }
  if (groups.size > 2) throw new Error('A media warm batch supports at most two assets');
  const results = new Map<MediaDeliveryWarmInput, MediaDeliveryWarmResult>();
  await Promise.all([...groups.values()].map(async group => {
    let source: Promise<Buffer | null> | undefined;
    const read: typeof readDeliverySource = pathname => { source ??= (dependencies.readSource ?? readDeliverySource)(pathname); return source; };
    for (const input of group) results.set(input, await (dependencies.warm ?? warmVariant)(input, read));
    // No source bytes escape the batch or enter the long-lived delivery cache.
  }));
  return inputs.map(input => results.get(input)!);
}
