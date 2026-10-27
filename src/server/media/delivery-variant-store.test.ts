import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { boundedVariantBytes, createVariantBlobStorage, declaredMediaVariants, warmMediaDeliveryVariants } from './delivery-variant-store';
import { deliveryVariantInput, deliveryVariantKey, deliveryVariantPath, type MediaDeliveryVariantRecord } from './delivery-variant-cache';
import { renderMediaDelivery } from './delivery';

const asset = { id: '00000000-0000-4000-8000-000000000001', blobPathname: 'ai/test/master.webp', kind: 'ingredient' };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const stream = (bytes: Buffer) => new Response(new Uint8Array(bytes)).body!;
async function fixture() {
  const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#d48752' } }).png().toBuffer();
  const photo = await renderMediaDelivery(source, 'ingredient', 160);
  const input = deliveryVariantInput(asset, 160);
  const record: MediaDeliveryVariantRecord = { ...input, key: deliveryVariantKey(input), sourceSha256: hash(source), sourceBytes: source.length,
    contentSha256: hash(photo.bytes), byteLength: photo.bytes.length, width: photo.width, height: photo.height, blobPathname: '' };
  record.blobPathname = deliveryVariantPath(record);
  return { record, bytes: photo.bytes, source };
}

test('Blob derivatives use private atomic create and verify exact readback before registering anything', async () => {
  const f = await fixture(); let saved: Buffer | null = null; let writes = 0;
  const storage = createVariantBlobStorage({
    put: async (pathname, bytes, options) => {
      writes++; assert.equal(pathname, f.record.blobPathname);
      assert.deepEqual(options, { access: 'private', contentType: 'image/webp', addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 });
      saved = Buffer.from(bytes);
    },
    read: async (pathname, useCache) => {
      assert.equal(pathname, f.record.blobPathname); assert.equal(useCache, false);
      return saved ? { stream: stream(saved), size: saved.length, contentType: 'image/webp' } : null;
    },
  });
  await storage.writeOnce(f.record, f.bytes); assert.equal(writes, 1);
});

test('uncertain uploads and duplicate-write races are recovered only from an identical origin object', async () => {
  const f = await fixture(); let saved: Buffer | null = null; let writes = 0;
  const storage = createVariantBlobStorage({
    put: async (_pathname, bytes) => { writes++; if (!saved) saved = Buffer.from(bytes); throw new Error('Connection lost or immutable duplicate'); },
    read: async (_pathname, useCache) => {
      assert.equal(useCache, false);
      return saved ? { stream: stream(saved), size: saved.length, contentType: 'image/webp' } : null;
    },
  });
  await Promise.all([storage.writeOnce(f.record, f.bytes), storage.writeOnce(f.record, f.bytes)]);
  assert.equal(writes, 2); assert.deepEqual(saved, f.bytes);
  saved = Buffer.from(f.bytes); saved[saved.length - 1] ^= 1;
  await assert.rejects(storage.writeOnce(f.record, f.bytes), /Invalid stored/);
  assert.equal(writes, 3, 'A conflict never causes an overwrite retry');
});

test('a missing readback, foreign pathname or wrong MIME cannot become a verified derivative', async () => {
  const f = await fixture(); let writes = 0;
  const missing = createVariantBlobStorage({ put: async () => { writes++; }, read: async () => null });
  await assert.rejects(missing.writeOnce(f.record, f.bytes), /unavailable/);
  await assert.rejects(missing.writeOnce({ ...f.record, blobPathname: 'ai/original.webp' }, f.bytes), /Invalid immutable/);
  assert.equal(writes, 1);
  const wrongMime = createVariantBlobStorage({ put: async () => {}, read: async () => ({ stream: stream(f.bytes), size: f.bytes.length, contentType: 'text/html' }) });
  await assert.rejects(wrongMime.writeOnce(f.record, f.bytes), /content type/);
});

test('bounded streams cancel oversized or truncated reads without trusting Content-Length', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedVariantBytes(oversized, 32), /bound/); assert.equal(cancelled, true);
  await assert.rejects(boundedVariantBytes(stream(Buffer.alloc(4)), 32, 5), /differs/);
  await assert.rejects(boundedVariantBytes(stream(Buffer.alloc(4)), 32, 33), /bound/);
});

test('chunked Blob GET size zero is an unknown length for both source reads and verified derivatives', async () => {
  const f = await fixture();
  assert.deepEqual(await boundedVariantBytes(stream(f.source), 32 * 1024 * 1024, 0), f.source);
  let saved = Buffer.from(f.bytes);
  const storage = createVariantBlobStorage({ put: async () => {}, read: async () => ({ stream: stream(saved), size: 0, contentType: 'image/webp' }) });
  assert.deepEqual(await storage.read(f.record.blobPathname, 4 * 1024 * 1024), f.bytes);
  await storage.writeOnce(f.record, f.bytes);
  saved = Buffer.from(f.bytes.subarray(0, -1));
  await assert.rejects(storage.writeOnce(f.record, f.bytes), /Invalid stored/);
  saved = Buffer.from(f.bytes); saved[saved.length - 1] ^= 1;
  await assert.rejects(storage.writeOnce(f.record, f.bytes), /Invalid stored/);
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedVariantBytes(oversized, 32, 0), /bound/); assert.equal(cancelled, true);
  await assert.rejects(boundedVariantBytes(stream(Buffer.alloc(0)), 32, 0), /differs/);
});

test('maintenance targets cover browser srcsets and every named registered hero size without inventing arbitrary dimensions', () => {
  const ingredient = declaredMediaVariants(asset);
  assert.equal(ingredient.length, 7); assert.equal(ingredient.at(-1)!.variantKey, 'responsive:1280');
  assert.equal(declaredMediaVariants({ ...asset, kind: 'step' }).length, 8);
  const hero = declaredMediaVariants({ ...asset, kind: 'hero' }); assert.equal(hero.length, 14);
  assert.equal(hero.filter(input => input.variantKey.startsWith('recipe:')).length, 5);
  assert(hero.some(input => input.variantKey === 'hero:full'));
  assert.equal(new Set(hero.map(deliveryVariantKey)).size, hero.length);
});

test('maintenance batches read each master once and bound simultaneous renderers to two assets', async () => {
  const assets = [asset, { ...asset, id: '00000000-0000-4000-8000-000000000002', blobPathname: 'ai/second/master.webp' }];
  const inputs = assets.flatMap(item => declaredMediaVariants(item)).map(input => ({ ...input, sourceIdentity: deliveryVariantKey(input) }));
  let sourceReads = 0, active = 0, maximum = 0;
  const results = await warmMediaDeliveryVariants(inputs, {
    readSource: async () => { sourceReads++; return Buffer.from('retained source'); },
    warm: async (input, read) => {
      active++; maximum = Math.max(maximum, active);
      assert.equal((await read(input.sourcePathname))?.toString(), 'retained source');
      await Promise.resolve(); active--;
      return { status: 'ready', bytes: 1, sourceIdentity: input.sourceIdentity, variantKey: input.variantKey };
    },
  });
  assert.equal(sourceReads, 2); assert.equal(maximum, 2); assert.equal(results.length, 14);
  await assert.rejects(warmMediaDeliveryVariants([...inputs, { ...inputs[0], assetId: '00000000-0000-4000-8000-000000000003' }]), /Invalid/);
});
