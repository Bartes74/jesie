import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createDeliveryVariantCache, deliveryVariantInput, deliveryVariantKey, maximumDeliveryVariantBytes,
  validVariantRecord, type DeliveryVariantCacheDependencies, type MediaDeliveryVariantRecord } from './delivery-variant-cache';
import { createMediaDeliveryService, renderMediaDelivery, type DeliveryAsset } from './delivery';
import { mediaDeliveryResponse } from './delivery-response';

const asset: DeliveryAsset = { id: '00000000-0000-4000-8000-000000000001', kind: 'ingredient', blobPathname: 'ai/recipe/original.webp' };
const input = deliveryVariantInput(asset, 160);
async function fixture() {
  const source = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#fa784600' } })
    .composite([{ input: await sharp({ create: { width: 256, height: 256, channels: 4, background: '#fa7846ff' } }).png().toBuffer(), left: 128, top: 128 }]).png().toBuffer();
  const photo = await renderMediaDelivery(source, 'ingredient', 160);
  const records = new Map<string, MediaDeliveryVariantRecord>();
  const blobs = new Map<string, Buffer>();
  let reads = 0, writes = 0, registrations = 0;
  const dependencies: DeliveryVariantCacheDependencies = {
    find: async value => records.get(deliveryVariantKey(value)) ?? null,
    readBlob: async (pathname, maximum) => {
      reads++; assert.equal(maximum, maximumDeliveryVariantBytes);
      return blobs.get(pathname) ?? null;
    },
    writeOnce: async (record, bytes) => {
      writes++;
      const prior = blobs.get(record.blobPathname);
      if (prior && !prior.equals(bytes)) throw new Error('Immutable object conflict');
      blobs.set(record.blobPathname, Buffer.from(bytes));
    },
    register: async record => {
      registrations++;
      if (!records.has(record.key)) records.set(record.key, structuredClone(record));
      return records.get(record.key)!;
    },
  };
  return { source, photo, records, blobs, dependencies, cache: createDeliveryVariantCache(dependencies), counts: () => ({ reads, writes, registrations }) };
}

test('a verified private derivative survives a fresh delivery process without source reads or rendering', async () => {
  const f = await fixture();
  assert.equal(await f.cache.write(input, f.source, f.photo), true);
  const fresh = createDeliveryVariantCache(f.dependencies);
  const delivery = createMediaDeliveryService({ isPublic: async () => true, isAdmin: async () => false, variants: fresh,
    read: async () => { throw new Error('A durable hit must not read the master'); },
    render: async () => { throw new Error('A durable hit must not render'); } });
  const result = await delivery(asset, 160);
  assert(result); assert.equal(result.public, true); assert.deepEqual(result.bytes, f.photo.bytes);
  assert.equal(result.width, 160); assert.equal(result.height, 160);
  const response = mediaDeliveryResponse(result, new Headers());
  assert.equal(mediaDeliveryResponse(result, new Headers({ 'If-None-Match': response.headers.get('ETag')! })).status, 304);
  const alpha = await sharp(result.bytes).extractChannel('alpha').raw().toBuffer();
  assert.equal(alpha[0], 0); assert.equal(alpha[80 * 160 + 80], 255);
});

test('source, kind, size and renderer binding reject foreign records before reading a Blob path', async () => {
  const f = await fixture(); await f.cache.write(input, f.source, f.photo);
  const record = f.records.get(deliveryVariantKey(input))!;
  for (const changed of [{ ...record, sourcePathname: 'ai/another.webp' }, { ...record, kind: 'step' as const },
    { ...record, variantKey: 'responsive:320' }, { ...record, rendererVersion: 'old-renderer' },
    { ...record, blobPathname: 'ai/private-original.webp' }, { ...record, sourceBytes: 33 * 1024 * 1024 }]) {
    assert.equal(validVariantRecord(changed, input), false);
    const cache = createDeliveryVariantCache({ ...f.dependencies, find: async () => changed,
      readBlob: async () => { throw new Error('A foreign record must not read any object'); } });
    assert.equal(await cache.read(input), null);
  }
});

test('missing, corrupt, oversized or dimension-mismatched derivatives are cache misses', async () => {
  const f = await fixture(); await f.cache.write(input, f.source, f.photo);
  const record = f.records.get(deliveryVariantKey(input))!;
  f.blobs.delete(record.blobPathname); assert.equal(await f.cache.read(input), null);
  const corrupt = Buffer.from(f.photo.bytes); corrupt[corrupt.length - 1] ^= 1;
  f.blobs.set(record.blobPathname, corrupt); assert.equal(await f.cache.read(input), null);
  f.blobs.set(record.blobPathname, Buffer.alloc(maximumDeliveryVariantBytes + 1)); assert.equal(await f.cache.read(input), null);
  f.blobs.set(record.blobPathname, f.photo.bytes);
  f.records.set(record.key, { ...record, height: 159 }); assert.equal(await f.cache.read(input), null);
});

test('a cache outage serves the ordinary source renderer and never changes source bytes', async () => {
  const f = await fixture(); const original = Buffer.from(f.source); let reads = 0;
  const delivery = createMediaDeliveryService({ isPublic: async () => true, isAdmin: async () => false,
    read: async () => { reads++; return f.source; }, variants: {
      read: async () => { throw new Error('Database temporarily unavailable'); },
      write: async () => { throw new Error('Blob temporarily unavailable'); },
    } });
  const photo = await delivery(asset, 160); assert(photo);
  assert.deepEqual(photo.bytes, f.photo.bytes); assert.deepEqual(f.source, original); assert.equal(reads, 1);
});

test('durable private pixels do not grant access and withdrawal during a cache read fails closed', async () => {
  const f = await fixture(); await f.cache.write(input, f.source, f.photo);
  let published = false, admin = false, cacheReads = 0;
  const delivery = createMediaDeliveryService({ isPublic: async () => published, isAdmin: async () => admin,
    read: async () => { throw new Error('Source must not be read'); }, variants: {
      read: async value => { cacheReads++; return f.cache.read(value); }, write: f.cache.write,
    } });
  assert.equal(await delivery(asset, 160), null); assert.equal(cacheReads, 0);
  admin = true; assert.equal((await delivery(asset, 160))?.public, false);
  admin = false; assert.equal(await delivery(asset, 160), null);
  const withdrawing = createMediaDeliveryService({ isPublic: async () => published, isAdmin: async () => false,
    read: async () => { throw new Error('Source must not be read'); }, variants: {
      read: async value => { const photo = await f.cache.read(value); published = false; return photo; }, write: f.cache.write,
    } });
  published = true; assert.equal(await withdrawing(asset, 160), null);
});

test('concurrent first delivery shares one render and persists one reusable result', async () => {
  const f = await fixture(); let reads = 0, renders = 0;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const delivery = createMediaDeliveryService({ isPublic: async () => true, isAdmin: async () => false, variants: f.cache,
    read: async () => { reads++; await gate; return f.source; },
    render: async (...args) => { renders++; return renderMediaDelivery(...args); } });
  const first = delivery(asset, 160), second = delivery(asset, 160); release();
  const photos = await Promise.all([first, second]); assert(photos.every(Boolean));
  assert.equal(reads, 1); assert.equal(renders, 1); assert.equal(f.counts().writes, 1);
  assert.equal(f.records.size, 1); assert.equal(f.blobs.size, 1);
});

test('a failed immutable write cannot publish a ready index record', async () => {
  const f = await fixture(); let registrations = 0;
  const cache = createDeliveryVariantCache({ ...f.dependencies,
    writeOnce: async () => { throw new Error('Uncertain transport or conflicting object'); },
    register: async value => { registrations++; return value; } });
  assert.equal(await cache.write(input, f.source, f.photo), false);
  assert.equal(registrations, 0); assert.equal(f.records.size, 0);
});

test('a concurrent registration winner must still carry the exact trusted source identity', async () => {
  const f = await fixture();
  const cache = createDeliveryVariantCache({ ...f.dependencies,
    register: async value => ({ ...value, assetId: '00000000-0000-4000-8000-000000000002' }) });
  assert.equal(await cache.write(input, f.source, f.photo), false);
});
