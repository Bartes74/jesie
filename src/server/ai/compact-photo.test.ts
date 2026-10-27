import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compactPhoto, losslessPhoto } from './compact-photo';

test('the editing archive preserves full resolution, exact alpha and color beneath transparent pixels', async () => {
  const width = 40, height = 30;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = index % 251;
    pixels[index * 4 + 1] = (index * 7) % 253;
    pixels[index * 4 + 2] = (index * 11) % 255;
    pixels[index * 4 + 3] = index % 3 === 0 ? 0 : index % 3 === 1 ? 137 : 255;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const archive = await losslessPhoto(png);
  const metadata = await sharp(archive).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
  assert.equal(metadata.hasAlpha, true);
  assert.deepEqual(await sharp(archive).ensureAlpha().raw().toBuffer(), pixels);
});

test('an opaque studio ingredient shares one lossless file without changing its backdrop or contact shadow', async () => {
  const width = 100, height = 80;
  const pixels = await sharp({ create: { width, height, channels: 3, background: '#FAF8F2' } }).raw().toBuffer();
  pixels.fill(200, 50 * width * 3, 51 * width * 3);
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const result = await compactPhoto(png, png, true);
  assert(result.shared); assert.strictEqual(result.archive, result.web);
  assert.deepEqual(await sharp(result.web).removeAlpha().raw().toBuffer(), pixels);
});

test('the delivery photo is compressed while the full resolution editing source stays lossless', async () => {
  const width = 180, height = 100;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = (x * 7 + y * 3) % 256;
    pixels[offset + 1] = (x * 3 + y * 11) % 256;
    pixels[offset + 2] = (x * 13 + y * 5) % 256;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const result = await compactPhoto(png, png, false);
  assert.equal(result.shared, false);
  assert.deepEqual(await sharp(result.archive).raw().toBuffer(), pixels);
  const metadata = await sharp(result.web).metadata();
  assert.equal(metadata.width, width); assert.equal(metadata.height, height);
  assert.equal(metadata.format, 'webp');
  const delivery = await sharp(result.web).removeAlpha().raw().toBuffer();
  assert.equal(delivery.length, pixels.length);
  const meanError = pixels.reduce((sum, value, index) => sum + Math.abs(value - delivery[index]), 0) / pixels.length;
  assert(meanError < 20, 'Delivery compression retains the photograph within a reasonable RGB error.');
});
