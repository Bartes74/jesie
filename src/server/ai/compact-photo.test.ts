import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('cutout and step delivery sources are lossy but keep exact alpha and opacity', async () => {
  const original = await sharp(readFileSync(new URL('../../../public/images/steps-lemon-pasta.webp', import.meta.url))).png().toBuffer();
  const { width, height } = await sharp(original).metadata() as { width: number; height: number };
  const cutoutPixels = await sharp(original).ensureAlpha().raw().toBuffer();
  for (let pixel = 0; pixel < width * height; pixel++) {
    const x = pixel % width, y = Math.floor(pixel / width);
    const distance = Math.hypot((x - width / 2) / (width * 0.4), (y - height / 2) / (height * 0.4));
    cutoutPixels[pixel * 4 + 3] = distance < 0.9 ? 255 : distance < 1 ? Math.round((1 - distance) * 2550) : 0;
  }
  const cutout = await sharp(cutoutPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const result = await compactPhoto(original, cutout, true);
  assert.equal(result.shared, false);
  assert(result.web.length * 2 < (await losslessPhoto(cutout)).length, 'A photographic delivery source is far smaller than a lossless copy.');
  const alpha = (bytes: Buffer) => sharp(bytes).ensureAlpha().extractChannel(3).raw().toBuffer();
  assert.deepEqual(await alpha(result.web), await alpha(cutout), 'The silhouette used for shadows and footprints is unchanged.');
  const step = await compactPhoto(original, original, false);
  assert.equal((await sharp(step.web).stats()).isOpaque, true, 'An opaque step photo gains no transparency.');
});

test('flat artwork keeps the smaller exact file instead of a larger lossy one', async () => {
  const flat = await sharp({ create: { width: 320, height: 200, channels: 4, background: '#f4efe6ff' } }).png().toBuffer();
  const shape = await sharp(flat).composite([{ input: await sharp({ create: { width: 100, height: 80, channels: 4, background: '#00000000' } }).png().toBuffer(), left: 0, top: 0 }]).png().toBuffer();
  const result = await compactPhoto(flat, shape, true);
  assert.deepEqual(result.web, await losslessPhoto(shape));
});
