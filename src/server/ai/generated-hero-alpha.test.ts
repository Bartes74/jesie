import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeGeneratedHeroAlpha } from './generated-hero-alpha';
import { PhotoFormatError, validateCutout, validateSolidHeroCutout } from './photo-format';

async function fixture(width: number, height: number, alpha: (x: number, y: number) => number) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set([x % 256, y % 256, (x * 13 + y * 7) % 256, alpha(x, y)], (y * width + x) * 4);
  }
  return { pixels, bytes: await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer() };
}

test('faint corner residue and near-opaque food become a valid solid cutout without changing RGB or intermediate alpha', async () => {
  const source = await fixture(100, 80, (x, y) => {
    if (x >= 20 && x < 25 && y >= 30 && y < 40) return 0;
    if (x >= 15 && x < 85 && y >= 10 && y < 70) return 250 + (x + y) % 5;
    if (x >= 13 && x < 87 && y >= 8 && y < 72) return 9 + (x + y) % 241;
    return 1 + (x + y) % 8;
  });
  await assert.rejects(validateCutout(source.bytes), error => error instanceof PhotoFormatError && error.code === 'PHOTO_CUTOUT_INVALID');
  const result = await normalizeGeneratedHeroAlpha(source.bytes);
  assert(result);
  assert.deepEqual([result.width, result.height], [100, 80]);
  const output = await sharp(result.bytes).raw().toBuffer();
  let changed = 0;
  for (let offset = 0; offset < source.pixels.length; offset += 4) {
    assert.deepEqual(output.subarray(offset, offset + 3), source.pixels.subarray(offset, offset + 3));
    const alpha = source.pixels[offset + 3];
    const expected = alpha <= 8 ? 0 : alpha >= 250 ? 255 : alpha;
    assert.equal(output[offset + 3], expected);
    if (alpha !== expected) changed++;
  }
  assert.equal(result.changedPixels, changed);
  assert.equal(output[(35 * 100 + 22) * 4 + 3], 0, 'The enclosed handle aperture is never filled.');
  await validateSolidHeroCutout(result.bytes);
});

test('every intermediate opacity, genuine aperture and fully transparent pixel stays unchanged', async () => {
  const source = await fixture(256, 3, (x, y) => y === 1 ? x : 0);
  const result = await normalizeGeneratedHeroAlpha(source.bytes);
  assert(result);
  const output = await sharp(result.bytes).raw().toBuffer();
  for (let x = 9; x <= 249; x++) assert.equal(output[(256 + x) * 4 + 3], x);
  for (const x of [0, 255]) assert.equal(output[(256 + x) * 4 + 3], x);
  const twice = await normalizeGeneratedHeroAlpha(result.bytes);
  assert(twice);
  assert.equal(twice.changedPixels, 0);
  assert.deepEqual(await sharp(twice.bytes).raw().toBuffer(), output);
});

test('normalization never fills missing food or closes an open vessel edge', async () => {
  const source = await fixture(100, 80, (x, y) => {
    const vessel = x >= 10 && x < 90 && y >= 10 && y < 70;
    const missingCenter = x >= 30 && x < 70 && y >= 25 && y < 55;
    const openingToExterior = x >= 45 && x < 55 && y < 40;
    return vessel && !missingCenter && !openingToExterior ? 252 : 1;
  });
  const result = await normalizeGeneratedHeroAlpha(source.bytes);
  assert(result);
  const output = await sharp(result.bytes).raw().toBuffer();
  assert.equal(output[(40 * 100 + 50) * 4 + 3], 0);
  assert.equal(output[(15 * 100 + 50) * 4 + 3], 0);
  await assert.rejects(validateSolidHeroCutout(result.bytes), error => error instanceof PhotoFormatError && /środek potrawy/.test(error.message));
});

test('unsupported images and images without alpha are left to the existing format handling', async () => {
  const opaque = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#eee' } }).png().toBuffer();
  const grayscaleAlpha = await sharp(Buffer.from([120, 252, 80, 1]), { raw: { width: 2, height: 1, channels: 2 } }).toColourspace('b-w').png().toBuffer();
  for (const source of [Buffer.alloc(0), Buffer.from('invalid'), opaque, grayscaleAlpha]) {
    assert.equal(await normalizeGeneratedHeroAlpha(source), null);
  }
});

test('an isolated handle touching one corner gains empty canvas with every source pixel preserved', async () => {
  const source = await fixture(100, 80, (x, y) => x >= 15 && x < 85 && y >= 10 && y < 70 || x > 95 && y < 4 ? 255 : 0);
  const result = await normalizeGeneratedHeroAlpha(source.bytes);
  assert(result?.padded);
  assert.deepEqual([result.width, result.height], [102, 82]);
  const restored = await sharp(result.bytes).extract({ left: 1, top: 1, width: 100, height: 80 }).raw().toBuffer();
  assert.deepEqual(restored, source.pixels);
  await validateSolidHeroCutout(result.bytes);
  const twice = await normalizeGeneratedHeroAlpha(result.bytes);
  assert(twice && !twice.padded && twice.changedPixels === 0);
});

test('padding cannot turn an opaque backdrop or a rim with missing food into an accepted cutout', async () => {
  const backdrop = await fixture(100, 80, (x, y) => x < 2 && y < 2 || x > 97 && y > 77 || x < 2 && y > 77 ? 0 : 255);
  const rim = await fixture(100, 80, (x, y) => x > 95 && y < 4 || x >= 15 && x < 85 && y >= 10 && y < 70 && !(x > 25 && x < 75 && y > 20 && y < 60) ? 255 : 0);
  const backgroundResult = await normalizeGeneratedHeroAlpha(backdrop.bytes);
  assert(backgroundResult && !backgroundResult.padded);
  await assert.rejects(validateSolidHeroCutout(backgroundResult.bytes), PhotoFormatError);
  const rimResult = await normalizeGeneratedHeroAlpha(rim.bytes);
  assert(rimResult?.padded);
  await assert.rejects(validateSolidHeroCutout(rimResult.bytes), /środek potrawy/);
});
