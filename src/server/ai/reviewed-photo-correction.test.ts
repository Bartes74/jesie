import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sameLiquidCreamPhotoForm, verifyReviewedHeroPixels } from './reviewed-photo-correction';
import { AiError } from './errors';
import { PhotoFormatError } from './photo-format';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('reviewed liquid cream aliases include target fat only within the source range and never accept whipped cream or another liquid', () => {
  const wanted = { name: { pl: 'śmietanka 30%', en: 'whipping cream' } };
  const source = { name: { pl: 'śmietanka 30% lub 36%', en: 'whipping cream, 30–36% fat' } };
  assert(sameLiquidCreamPhotoForm(wanted, source));
  assert(sameLiquidCreamPhotoForm(wanted, { ...source, note: { pl: 'Nieubita.', en: 'Unwhipped.' } }));
  assert(!sameLiquidCreamPhotoForm({ name: { pl: 'śmietanka 36%', en: 'double cream, 36% fat' } }, wanted));
  assert(!sameLiquidCreamPhotoForm(wanted, { ...source, note: { pl: 'Ubita.', en: 'Whipped.' } }));
  assert(!sameLiquidCreamPhotoForm(wanted, { name: { pl: 'mleko', en: 'milk' } }));
});
async function pixels(transform: (x: number, y: number) => number[]) {
  const data = Buffer.alloc(40 * 40 * 4);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) Buffer.from(transform(x, y)).copy(data, (y * 40 + x) * 4);
  return sharp(data, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
}
test('reviewed mask import proves all source RGB pixels, opacity, exact geometry and both hashes', async () => {
  const source = await pixels((x, y) => [x * 4, y * 4, x + y, 255]);
  const fixed = await pixels((x, y) => [x * 4, y * 4, x + y, x >= 5 && x < 35 && y >= 5 && y < 35 ? 255 : 0]);
  assert.deepEqual(await verifyReviewedHeroPixels(source, fixed, sha(source), sha(fixed)), { width: 40, height: 40 });
  const recoloured = await pixels((x, y) => [x * 4 + (x === 0 && y === 0 ? 1 : 0), y * 4, x + y, x >= 5 && x < 35 && y >= 5 && y < 35 ? 255 : 0]);
  await assert.rejects(verifyReviewedHeroPixels(source, recoloured, sha(source), sha(recoloured)), (error: unknown) => error instanceof AiError && error.code === 'SOURCE_PIXELS_CHANGED');
  await assert.rejects(verifyReviewedHeroPixels(source, fixed, '0'.repeat(64), sha(fixed)), (error: unknown) => error instanceof AiError && error.code === 'IMPORTED_IMAGE_INVALID');
  const transparentSource = await pixels((x, y) => [x * 4, y * 4, x + y, x === 0 && y === 0 ? 0 : 255]);
  await assert.rejects(verifyReviewedHeroPixels(transparentSource, fixed, sha(transparentSource), sha(fixed)), (error: unknown) => error instanceof AiError && error.code === 'PHOTO_SOURCE_INVALID');
  const resized = await sharp(fixed).resize(20, 20).png().toBuffer();
  await assert.rejects(verifyReviewedHeroPixels(source, resized, sha(source), sha(resized)), (error: unknown) => error instanceof AiError && error.code === 'IMPORTED_IMAGE_INVALID');
  const rim = await pixels((x, y) => [x * 4, y * 4, x + y, x >= 5 && x < 35 && y >= 5 && y < 35 && !(x >= 8 && x < 32 && y >= 8 && y < 32) ? 255 : 0]);
  await assert.rejects(verifyReviewedHeroPixels(source, rim, sha(source), sha(rim)), (error: unknown) => error instanceof PhotoFormatError && error.code === 'PHOTO_CUTOUT_INVALID');
});
