import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createMediaDeliveryService, renderMediaDelivery, type DeliveryAsset } from './delivery';

const asset: DeliveryAsset = { id: '00000000-0000-4000-8000-000000000001', kind: 'ingredient', blobPathname: 'ai/source.webp' };

test('ingredient thumbnails reduce bytes and resolution without changing the archive or its proportions', async () => {
  const width = 1024, height = 512;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels.set([Math.round(x / 4), Math.round(y / 2), Math.round((x + y) / 6)], offset);
  }
  const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const untouched = Buffer.from(source);
  const image = await renderMediaDelivery(source, 'ingredient', 160);
  assert.deepEqual(source, untouched);
  assert.equal(image.width, 160); assert.equal(image.height, 80);
  assert.ok(image.bytes.length < source.length / 4);
  const expected = await sharp(source).resize({ width: 160 }).removeAlpha().raw().toBuffer();
  const actual = await sharp(image.bytes).removeAlpha().raw().toBuffer();
  const error = expected.reduce((sum, value, index) => sum + Math.abs(value - actual[index]), 0) / expected.length;
  assert.ok(error < 4, `Mean RGB error ${error} must retain a smooth photograph's tones`);
});

test('step variants retain the entire frame and do not enlarge a small source', async () => {
  const source = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ab7846' } }).png().toBuffer();
  const image = await renderMediaDelivery(source, 'step', 640);
  assert.equal(image.width, 64); assert.equal(image.height, 32);
  assert.equal((await sharp(image.bytes).metadata()).format, 'webp');
});

test('hero variants keep the complete centred vessel and transparent corners at screen resolution', async () => {
  const source = await sharp({ create: { width: 1000, height: 1000, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 850, height: 700, channels: 4, background: '#be301aff' } }).png().toBuffer(), left: 75, top: 150 }]).png().toBuffer();
  const image = await renderMediaDelivery(source, 'hero', 640);
  assert.equal(image.width, 640); assert.equal(image.height, 640);
  const output = await sharp(image.bytes).ensureAlpha().raw().toBuffer();
  for (const [x, y] of [[0, 0], [639, 0], [0, 639], [639, 639]]) assert.equal(output[(y * 640 + x) * 4 + 3], 0);
  assert.equal(output[(320 * 640 + 320) * 4 + 3], 255);
  // The full vessel occupies the same 92% canvas used by the uncompressed view.
  const alpha = await sharp(image.bytes).extractChannel('alpha').raw().toBuffer();
  const visible = Array.from(alpha.entries()).filter(([, value]) => value > 0).map(([index]) => index % 640);
  assert.ok(Math.min(...visible.slice(0, 600)) >= 15);
  assert.ok(Math.max(...visible.slice(-600)) <= 625);
});

test('delivery rejects arbitrary widths and disguised SVG before decoding', async () => {
  await assert.rejects(renderMediaDelivery(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'step', 640), /Invalid raster/);
  await assert.rejects(renderMediaDelivery(Buffer.from('unused'), 'step', 999 as 640), /Unsupported/);
});

function fixture() {
  let published = true, admin = false, reads = 0, renders = 0, checks = 0;
  const image = { bytes: Buffer.from('private thumbnail'), width: 160, height: 160 };
  const delivery = createMediaDeliveryService({
    isPublic: async () => { checks++; return published; },
    isAdmin: async () => admin,
    read: async () => { reads++; return Buffer.from('source'); },
    render: async () => { renders++; return image; },
  });
  return { delivery, image, counts: () => ({ reads, renders, checks }), published: (value: boolean) => { published = value; }, admin: (value: boolean) => { admin = value; } };
}

test('a cached public thumbnail becomes inaccessible immediately after withdrawal', async () => {
  const f = fixture();
  assert.equal((await f.delivery(asset, 160))?.public, true);
  assert.equal((await f.delivery(asset, 160))?.public, true);
  assert.deepEqual(f.counts(), { reads: 1, renders: 1, checks: 4 });
  f.published(false);
  assert.equal(await f.delivery(asset, 160), null);
  assert.equal(f.counts().reads, 1);
});

test('draft variants require an admin and remain private even when pixels are cached', async () => {
  const f = fixture(); f.published(false);
  assert.equal(await f.delivery(asset, 160), null);
  assert.equal(f.counts().reads, 0);
  f.admin(true);
  assert.equal((await f.delivery(asset, 160))?.public, false);
  f.admin(false);
  assert.equal(await f.delivery(asset, 160), null);
});

test('withdrawal during a cache hit or first decode prevents a public response', async () => {
  let allowed = true, calls = 0;
  const delivery = createMediaDeliveryService({
    isPublic: async () => ++calls === 1 || allowed,
    isAdmin: async () => false,
    read: async () => Buffer.from('source'),
    render: async () => { allowed = false; return { bytes: Buffer.from('pixels'), width: 160, height: 160 }; },
  });
  assert.equal(await delivery(asset, 160), null);
  assert.equal(await delivery(asset, 160), null);
});

test('invalid IDs and unsupported media kinds cannot read sources or consult sessions', async () => {
  const f = fixture();
  assert.equal(await f.delivery({ ...asset, id: '../private' }, 160), null);
  assert.equal(await f.delivery({ ...asset, kind: 'mask' }, 160), null);
  assert.deepEqual(f.counts(), { reads: 0, renders: 0, checks: 0 });
});

test('the ephemeral variant cache is bounded and evicts old entries without retaining sources', async () => {
  const f = fixture();
  await f.delivery(asset, 160);
  for (let index = 2; index <= 130; index++) await f.delivery({ ...asset, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }, 160);
  const before = f.counts().reads;
  await f.delivery(asset, 160);
  assert.equal(f.counts().reads, before + 1);
});
