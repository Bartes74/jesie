import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeHeroPresentation } from './hero-presentation';
import { validateCutout } from './photo-format';

async function image(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { data, bytes: await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() };
}

test('wide, off-centre cutouts become a centred square without altering food, holes or alpha=1 rim pixels', async () => {
  const source = await image(240, 100, (x, y) => {
    let alpha = x >= 137 && x < 211 && y >= 9 && y < 72 ? 255 : 0;
    if (x === 136 && y === 40) alpha = 1;
    if (x === 174 && y === 30) alpha = 0;
    if (x === 210 && y === 41) alpha = 127;
    return [x % 256, y % 256, (x * 3 + y * 7) % 256, alpha];
  });
  const result = await normalizeHeroPresentation(source.bytes);
  assert(result);
  assert.equal(result.width, result.height);
  const before = await validateCutout(source.bytes);
  const after = await validateCutout(result.bytes);
  assert.deepEqual({ width: after.bounds.width, height: after.bounds.height }, { width: before.bounds.width, height: before.bounds.height });
  assert.equal(after.foregroundPixels, before.foregroundPixels);
  assert.equal(after.opaquePixels, before.opaquePixels);
  assert(Math.abs(after.bounds.left - (result.width - after.bounds.left - after.bounds.width)) <= 1);
  assert(Math.abs(after.bounds.top - (result.height - after.bounds.top - after.bounds.height)) <= 1);
  const occupancy = Math.max(after.bounds.width, after.bounds.height) / result.width;
  assert(occupancy <= 0.92 && occupancy > 0.92 - 1 / result.width);
  const { data } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    const offset: number = (y * result.width + x) * 4;
    const localX = x - after.bounds.left;
    const localY = y - after.bounds.top;
    if (localX >= 0 && localX < before.bounds.width && localY >= 0 && localY < before.bounds.height) {
      const sourceOffset = ((before.bounds.top + localY) * 240 + before.bounds.left + localX) * 4;
      assert.deepEqual(data.subarray(offset, offset + 4), source.data.subarray(sourceOffset, sourceOffset + 4));
    } else assert.deepEqual([...data.subarray(offset, offset + 4)], [0, 0, 0, 0]);
  }
});

test('a full-resolution 4:3 dish remains complete and uses the same presentation scale as existing square photos', async () => {
  const source = await image(2560, 1920, (x, y) => [234, 202, 115, x >= 392 && x < 2168 && y >= 48 && y < 1840 ? 255 : 0]);
  const result = await normalizeHeroPresentation(source.bytes);
  assert(result);
  assert.equal(result.width, result.height);
  assert(result.width * result.height <= 8_500_000);
  const after = await validateCutout(result.bytes);
  assert.equal(after.foregroundPixels, 1776 * 1792);
  assert.equal(after.opaquePixels, 1776 * 1792);
  assert.deepEqual({ width: after.bounds.width, height: after.bounds.height }, { width: 1776, height: 1792 });
  assert(Math.abs(Math.max(after.bounds.width, after.bounds.height) / result.width - 0.92) < 0.001);
});

test('tall glass silhouettes retain their neck, closure and translucent edges on a centred square', async () => {
  const source = await image(200, 300, (x, y) => {
    const body = x >= 65 && x <= 124 && y >= 80 && y < 280;
    const neck = x >= 82 && x <= 107 && y >= 15 && y < 80;
    const reflection = x === 64 && y >= 90 && y < 260;
    return [222, 176, 56, body || neck ? 255 : reflection ? 64 : 0];
  });
  const result = await normalizeHeroPresentation(source.bytes);
  assert(result);
  const before = await validateCutout(source.bytes);
  const after = await validateCutout(result.bytes);
  assert.equal(result.width, result.height);
  assert.equal(after.bounds.width / after.bounds.height, before.bounds.width / before.bounds.height);
  assert.equal(after.foregroundPixels, before.foregroundPixels);
  assert.equal(after.opaquePixels, before.opaquePixels);
  assert(Math.abs(after.bounds.left - (result.width - after.bounds.left - after.bounds.width)) <= 1);
  assert(Math.abs(after.bounds.top - (result.height - after.bounds.top - after.bounds.height)) <= 1);
});

test('opaque, empty, trivial or uncut images fall back to their original delivery', async () => {
  const opaqueRgb = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal(await normalizeHeroPresentation(opaqueRgb), null);
  for (const pixel of [
    () => [240, 220, 190, 255],
    () => [240, 220, 190, 0],
    (x: number, y: number) => [240, 220, 190, x === 10 && y === 10 ? 255 : 0],
    (x: number, y: number) => [240, 220, 190, (x >= 5 && x <= 14 && y >= 5 && y <= 14) || (x === 0 && y === 0) ? 255 : 0],
  ]) assert.equal(await normalizeHeroPresentation((await image(20, 20, pixel)).bytes), null);
});

test('normalization never expands a thin cutout into an unsafe square or accepts an oversized payload', async () => {
  const source = await image(3200, 10, (x, y) => [246, 232, 215, x > 0 && x < 3199 && y > 0 && y < 9 ? 255 : 0]);
  assert.equal(await normalizeHeroPresentation(source.bytes), null);
  assert.equal(await normalizeHeroPresentation(Buffer.alloc(32 * 1024 * 1024 + 1)), null);
  await assert.rejects(normalizeHeroPresentation(Buffer.from('corrupt image')));
});
