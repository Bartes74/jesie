import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { applyHeroMask, cropStepPhoto, fillCookwareInterior, fillEnclosedCutout, fillReviewedHeroSeams, fillSauceboatInterior, maskReviewedRoundVessel, PhotoFormatError, validateCutout, validateSolidHeroCutout, validateGlassHeroCutout } from './photo-format';

async function image(width: number, height: number, pixel: (x: number, y: number) => number[], channels: 3 | 4 = 3) {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const values = pixel(x, y);
    for (let channel = 0; channel < channels; channel++) data[(y * width + x) * channels + channel] = values[channel];
  }
  return { data, bytes: await sharp(data, { raw: { width, height, channels } }).png().toBuffer() };
}

async function decoded(bytes: Buffer, alpha = false) {
  const decoder = sharp(bytes).toColourspace('srgb');
  if (alpha) decoder.ensureAlpha();
  return decoder.raw().toBuffer({ resolveWithObject: true });
}

const failure = (code: PhotoFormatError['code']) => (error: unknown) => error instanceof PhotoFormatError && error.code === code;

test('glass mask validation rejects erased food in the upper bowl even when the lower bowl passes solid checks', async () => {
  for (const missingAlpha of [0, 9]) for (const openSurface of [false, true]) {
    const cutout = await image(120, 160, (x, y) => {
      const bowl = x >= 15 && x < 105 && y >= 10 && y < 110;
      const foot = x >= 30 && x < 90 && y >= 140 && y < 150;
      const stem = x >= 53 && x < 67 && y >= 110 && y < 140;
      let alpha = bowl || foot || stem ? 255 : 0;
      if (x >= (openSurface ? 15 : 30) && x < 90 && y >= 20 && y < 50) alpha = missingAlpha;
      return [190, 170, 130, alpha];
    }, 4);
    await validateCutout(cutout.bytes);
    await validateSolidHeroCutout(cutout.bytes);
    await assert.rejects(validateGlassHeroCutout(cutout.bytes), failure('PHOTO_CUTOUT_INVALID'));
  }
});

test('glass food validation preserves intentional wall, stem and foot transparency without changing pixels', async () => {
  const cutout = await image(120, 160, (x, y) => {
    const bowl = x >= 15 && x < 105 && y >= 10 && y < 110;
    const foot = x >= 30 && x < 90 && y >= 140 && y < 150;
    const stem = x >= 53 && x < 67 && y >= 110 && y < 140;
    const contents = x >= 30 && x < 90 && y >= 25 && y < 105;
    return [x, y, x + y, contents ? y >= 90 ? 255 : 120 : bowl || foot || stem ? 90 : 0];
  }, 4);
  const before = Buffer.from(cutout.bytes);
  await validateGlassHeroCutout(cutout.bytes);
  assert.deepEqual(cutout.bytes, before);
  const output = (await decoded(cutout.bytes, true)).data;
  assert.equal(output[(20 * 120 + 20) * 4 + 3], 90);
  assert.equal(output[(120 * 120 + 60) * 4 + 3], 90);
  assert.equal(output[(145 * 120 + 60) * 4 + 3], 90);
});

test('1536 × 1024 becomes 1533 × 657, with every retained RGB pixel unchanged', async () => {
  const source = await image(1536, 1024, (x, y) => [x % 256, y % 256, (x + 3 * y) % 256]);
  const result = await cropStepPhoto(source.bytes);
  assert.equal(result.width, 1533);
  assert.equal(result.height, 657);
  assert.equal(result.width * 3, result.height * 7);
  const output = await decoded(result.bytes);
  assert.equal(output.info.channels, 3);
  for (let y = 0; y < 657; y++) {
    const start = ((y + 183) * 1536 + 1) * 3;
    assert.deepEqual(output.data.subarray(y * 1533 * 3, (y + 1) * 1533 * 3), source.data.subarray(start, start + 1533 * 3));
  }
});

test('an already exact 21:9 photograph retains its size and RGBA pixels', async () => {
  const source = await image(224, 96, (x, y) => [x, y, 241, 255], 4);
  const result = await cropStepPhoto(source.bytes);
  assert.deepEqual({ width: result.width, height: result.height }, { width: 224, height: 96 });
  assert.deepEqual((await decoded(result.bytes, true)).data, source.data);
});

test('a step photograph with see-through pixels inside the crop is rejected; transparency cropped away is not', async () => {
  const holed = await image(224, 96, (x, y) => [180, 180, 185, x >= 100 && x < 120 && y >= 40 && y < 60 ? 0 : 255], 4);
  await assert.rejects(cropStepPhoto(holed.bytes), failure('PHOTO_SOURCE_INVALID'));
  const faint = await image(224, 96, () => [180, 180, 185, 254], 4);
  await assert.rejects(cropStepPhoto(faint.bytes), failure('PHOTO_SOURCE_INVALID'));
  const margin = await image(224, 120, (x, y) => [180, 180, 185, y < 12 || y >= 108 ? 0 : 255], 4);
  assert.deepEqual(await cropStepPhoto(margin.bytes).then(result => [result.width, result.height]), [224, 96]);
});

test('generic dimensions use the largest integer 7:3 crop without adding pixels', async () => {
  const source = await image(102, 91, (x, y) => [x, y, 17]);
  const result = await cropStepPhoto(source.bytes);
  assert.deepEqual({ width: result.width, height: result.height }, { width: 98, height: 42 });
  const output = await decoded(result.bytes);
  assert.deepEqual([...output.data.subarray(0, 3)], [2, 24, 17]);
  assert.deepEqual([...output.data.subarray(-3)], [99, 65, 17]);
});

test('an atlas crop selects the requested tile before cropping to 21:9', async () => {
  const source = await image(84, 60, (x, y) => [x, y, y >= 30 && x < 42 ? 91 : 7]);
  const result = await cropStepPhoto(source.bytes, { columns: 2, rows: 2, index: 2 });
  assert.deepEqual({ width: result.width, height: result.height }, { width: 42, height: 18 });
  const output = await decoded(result.bytes);
  assert.deepEqual([...output.data.subarray(0, 3)], [0, 36, 91]);
  assert.deepEqual([...output.data.subarray(-3)], [41, 53, 91]);
});

test('invalid tiles, tiny sources and malformed images fail without inventing a crop', async () => {
  const source = await image(14, 9, () => [255, 0, 0]);
  for (const tile of [{ columns: 0, rows: 1, index: 0 }, { columns: 1, rows: 1, index: 1 }, { columns: 2, rows: 1, index: 0.5 }, { columns: 20, rows: 1, index: 0 }]) {
    await assert.rejects(cropStepPhoto(source.bytes, tile), failure('PHOTO_TILE_INVALID'));
  }
  await assert.rejects(cropStepPhoto((await image(6, 3, () => [0, 0, 0])).bytes), failure('PHOTO_SOURCE_INVALID'));
  await assert.rejects(cropStepPhoto(Buffer.from('not an image')), failure('PHOTO_SOURCE_INVALID'));
});

test('black/white masking preserves white ceramic, dark food and soft edge RGB', async () => {
  const source = await image(8, 6, (x, y) => x === 4 && y === 3 ? [8, 13, 6] : [246, 242, 230]);
  const mask = await image(8, 6, (x, y) => {
    const opacity = x >= 2 && x <= 5 && y >= 1 && y <= 4 ? (x === 2 ? 127 : 255) : 0;
    return [opacity, opacity, opacity];
  });
  const result = await applyHeroMask(source.bytes, mask.bytes);
  const output = await decoded(result.bytes, true);
  for (let pixel = 0; pixel < 48; pixel++) {
    assert.deepEqual(output.data.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
    assert.equal(output.data[pixel * 4 + 3], mask.data[pixel * 3]);
  }
  const checks = await validateCutout(result.bytes);
  assert.deepEqual(checks, { width: 8, height: 6, transparentPixels: 32, foregroundPixels: 16, opaquePixels: 12, bounds: { left: 2, top: 1, width: 4, height: 4 } });
});

test('transparent coloured segmentation previews use their alpha, without recolouring the source', async () => {
  const source = await image(8, 6, (x, y) => [240 - x, 220 + y, 190, x === 3 && y === 2 ? 128 : 255], 4);
  const mask = await image(8, 6, (x, y) => [23, 117, 231, x >= 2 && x <= 5 && y >= 1 && y <= 4 ? (x === 3 && y === 2 ? 128 : 255) : 0], 4);
  const output = await decoded((await applyHeroMask(source.bytes, mask.bytes)).bytes, true);
  for (let pixel = 0; pixel < 48; pixel++) {
    assert.deepEqual(output.data.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 4, pixel * 4 + 3));
    assert.equal(output.data[pixel * 4 + 3], Math.round(source.data[pixel * 4 + 3] * mask.data[pixel * 4 + 3] / 255));
  }
  assert.equal(output.data[(2 * 8 + 3) * 4 + 3], 64);
});

test('an opaque RGBA mask uses its black/white values rather than its uniformly full alpha channel', async () => {
  const source = (await image(8, 6, () => [249, 246, 238])).bytes;
  const mask = (await image(8, 6, (x, y) => {
    const value = x >= 2 && x <= 5 && y >= 1 && y <= 4 ? 255 : 0;
    return [value, value, value, 255];
  }, 4)).bytes;
  const result = await applyHeroMask(source, mask);
  const output = await decoded(result.bytes, true);
  assert.equal(output.data[3], 0);
  assert.equal(output.data[(2 * 8 + 3) * 4 + 3], 255);
  assert.equal((await validateCutout(result.bytes)).foregroundPixels, 16);
});

test('a lower-resolution matching mask is resized while original RGB and dimensions stay unchanged', async () => {
  const source = await image(16, 12, (x, y) => [x * 11, y * 13, 251]);
  const mask = await image(8, 6, (x, y) => {
    const opacity = x >= 2 && x <= 5 && y >= 1 && y <= 4 ? 255 : 0;
    return [opacity, opacity, opacity];
  });
  const result = await applyHeroMask(source.bytes, mask.bytes);
  assert.deepEqual({ width: result.width, height: result.height }, { width: 16, height: 12 });
  const output = await decoded(result.bytes, true);
  for (let pixel = 0; pixel < 192; pixel++) assert.deepEqual(output.data.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
  assert.equal(output.data[(6 * 16 + 8) * 4 + 3], 255);
  assert.equal(output.data[3], 0);
});

test('mask aspect mismatches and opaque coloured previews fail instead of stretching or guessing', async () => {
  const source = (await image(8, 6, () => [240, 239, 227])).bytes;
  await assert.rejects(applyHeroMask(source, (await image(6, 6, () => [255, 255, 255])).bytes), failure('PHOTO_MASK_INVALID'));
  await assert.rejects(applyHeroMask(source, (await image(8, 6, () => [0, 50, 200])).bytes), failure('PHOTO_MASK_INVALID'));
  await assert.rejects(applyHeroMask(source, Buffer.from('invalid mask')), failure('PHOTO_MASK_INVALID'));
});

test('cutout validation rejects missing, opaque, empty and trivial alpha, and leftover corner background', async () => {
  await assert.rejects(validateCutout((await image(8, 6, () => [255, 255, 255])).bytes), failure('PHOTO_CUTOUT_INVALID'));
  for (const alpha of [0, 127, 255]) {
    await assert.rejects(validateCutout((await image(8, 6, () => [240, 240, 240, alpha], 4)).bytes), failure('PHOTO_CUTOUT_INVALID'));
  }
  await assert.rejects(validateCutout((await image(8, 6, (x, y) => [240, 240, 240, x === 3 && y === 3 ? 255 : 0], 4)).bytes), failure('PHOTO_CUTOUT_INVALID'));
  await assert.rejects(validateCutout((await image(8, 6, (x, y) => [240, 240, 240, (x >= 2 && x <= 5 && y >= 1 && y <= 4) || (x === 0 && y === 0) ? 255 : 0], 4)).bytes), failure('PHOTO_CUTOUT_INVALID'));
});

test('near-opaque generated interiors pass without changing RGB, soft edges or alpha', async () => {
  for (const alpha of [250, 251, 252, 253, 254]) {
    const source = await image(12, 10, (x, y) => {
      const inside = x >= 2 && x <= 9 && y >= 2 && y <= 7;
      return [x * 17, y * 19, 203, inside ? x === 2 ? 127 : alpha : 0];
    }, 4);
    const originalBytes = Buffer.from(source.bytes);
    const checked = await validateCutout(source.bytes);
    assert.deepEqual(checked, { width: 12, height: 10, transparentPixels: 72, foregroundPixels: 48, opaquePixels: 42,
      bounds: { left: 2, top: 2, width: 8, height: 6 } });
    await validateSolidHeroCutout(source.bytes);
    assert.deepEqual(source.bytes, originalBytes, 'Validation never rewrites the encoded image.');
    assert.deepEqual((await decoded(source.bytes, true)).data, source.data, 'Every RGB and alpha value stays intact.');
  }
});

test('transparent surroundings cannot make a translucent interior or leftover corner background valid', async () => {
  for (const alpha of [0, 127, 249]) {
    const source = await image(12, 10, (x, y) => [170, 130, 90, x >= 2 && x <= 9 && y >= 2 && y <= 7 ? alpha : 0], 4);
    await assert.rejects(validateCutout(source.bytes), failure('PHOTO_CUTOUT_INVALID'));
  }
  for (const cornerAlpha of [1, 127, 250, 255]) {
    const source = await image(12, 10, (x, y) => [170, 130, 90, x === 0 && y === 0 ? cornerAlpha : x >= 2 && x <= 9 && y >= 2 && y <= 7 ? 251 : 0], 4);
    await assert.rejects(validateCutout(source.bytes), failure('PHOTO_CUTOUT_INVALID'));
  }
});

test('empty and uniformly full masks never return a usable hero', async () => {
  const source = (await image(8, 6, () => [247, 244, 231])).bytes;
  for (const value of [0, 255]) {
    await assert.rejects(applyHeroMask(source, (await image(8, 6, () => [value, value, value])).bytes), failure('PHOTO_CUTOUT_INVALID'));
  }
  await assert.rejects(applyHeroMask(source, (await image(8, 6, () => [255, 255, 255, 0], 4)).bytes), failure('PHOTO_MASK_INVALID'));
});

test('mask application preserves enclosed holes rather than guessing a different silhouette', async () => {
  const source = (await image(9, 9, () => [249, 246, 234])).bytes;
  const mask = (await image(9, 9, (x, y) => {
    const opacity = x >= 2 && x <= 6 && y >= 2 && y <= 6 && !(x === 4 && y === 4) ? 255 : 0;
    return [opacity, opacity, opacity];
  })).bytes;
  const result = await applyHeroMask(source, mask);
  assert.equal((await decoded(result.bytes, true)).data[(4 * 9 + 4) * 4 + 3], 0);
  assert.equal((await validateCutout(result.bytes)).foregroundPixels, 24);
});

test('enclosed food holes are restored from source RGB while exterior and soft vessel edges stay unchanged', async () => {
  const source = await image(11, 11, (x, y) => [231 + x, 137 + y, (x * 17 + y * 9) % 256]);
  const cutout = await image(11, 11, (x, y) => {
    let alpha = x >= 2 && x <= 8 && y >= 2 && y <= 8 ? 255 : 0;
    if (x === 2 && y === 5) alpha = 127; // Keep the existing outer edge.
    if (x === 1 && y === 5) alpha = 5; // Near-transparent exterior must survive unchanged.
    if (x >= 4 && x <= 6 && y >= 4 && y <= 6) alpha = x === 4 ? 8 : 0;
    return [0, 0, 0, alpha]; // A segmented WebP may have discarded the food RGB.
  }, 4);
  const existingWebp = await sharp(cutout.bytes).webp({ lossless: true }).toBuffer();
  const result = await fillEnclosedCutout(source.bytes, existingWebp);
  assert.deepEqual({ width: result.width, height: result.height, filledPixels: result.filledPixels }, { width: 11, height: 11, filledPixels: 9 });
  const output = await decoded(result.bytes, true);
  for (let pixel = 0; pixel < 121; pixel++) {
    assert.deepEqual(output.data.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
    const x = pixel % 11, y = Math.floor(pixel / 11);
    assert.equal(output.data[pixel * 4 + 3], x >= 4 && x <= 6 && y >= 4 && y <= 6 ? 255 : cutout.data[pixel * 4 + 3]);
  }
  const checked = await validateCutout(result.bytes);
  assert(checked.transparentPixels > 0);
  assert(checked.opaquePixels > 0);
});

test('a food cavity connected to the image perimeter is never filled', async () => {
  const source = (await image(9, 9, (x, y) => [211, x + 20, y + 30])).bytes;
  const cutout = await image(9, 9, (x, y) => {
    let alpha = x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 255 : 0;
    if (x >= 3 && x <= 5 && y >= 3 && y <= 5) alpha = 0;
    if (x === 4 && y <= 3) alpha = 0; // An open gap through the upper rim.
    return [250, 250, 250, alpha];
  }, 4);
  const result = await fillEnclosedCutout(source, cutout.bytes);
  assert.equal(result.filledPixels, 0);
  const output = await decoded(result.bytes, true);
  for (let pixel = 0; pixel < 81; pixel++) assert.equal(output.data[pixel * 4 + 3], cutout.data[pixel * 4 + 3]);
});

test('a diagonal opening to the exterior remains open', async () => {
  const source = (await image(9, 9, () => [246, 241, 230])).bytes;
  const cutout = await image(9, 9, (x, y) => {
    let alpha = x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 255 : 0;
    if ((x >= 3 && x <= 5 && y >= 3 && y <= 5) || (x === 2 && y === 2)) alpha = 0;
    return [246, 241, 230, alpha];
  }, 4);
  const result = await fillEnclosedCutout(source, cutout.bytes);
  assert.equal(result.filledPixels, 0);
  assert.equal((await decoded(result.bytes, true)).data[(4 * 9 + 4) * 4 + 3], 0);
});

test('enclosed repair requires exact dimensions and a complete opaque source', async () => {
  const source = (await image(9, 9, () => [249, 246, 234])).bytes;
  const cutout = (await image(9, 9, (x, y) => [249, 246, 234, x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 255 : 0], 4)).bytes;
  await assert.rejects(fillEnclosedCutout((await image(18, 18, () => [249, 246, 234])).bytes, cutout), failure('PHOTO_MASK_INVALID'));
  const incomplete = (await image(9, 9, (x, y) => [249, 246, 234, x === 4 && y === 4 ? 0 : 255], 4)).bytes;
  await assert.rejects(fillEnclosedCutout(incomplete, cutout), failure('PHOTO_SOURCE_INVALID'));
  await assert.rejects(fillEnclosedCutout(source, (await image(9, 9, () => [249, 246, 234])).bytes), failure('PHOTO_CUTOUT_INVALID'));
});

test('sauce boat repair restores its removed food surface while preserving the smaller handle aperture and rim', async () => {
  const source = await image(100, 70, (x, y) => [180 + x % 70, 100 + y, x + y]);
  const cutout = await image(100, 70, (x, y) => {
    let alpha = x >= 10 && x < 90 && y >= 10 && y < 60 ? 255 : 0;
    if (x >= 20 && x < 65 && y >= 17 && y < 29) alpha = x === 20 ? 8 : 0; // Erased sauce surface.
    if (x >= 80 && x < 86 && y >= 15 && y < 36) alpha = 0; // Handle aperture.
    if (x === 75 && y === 45) alpha = 0; // A tiny uncertain opening must also survive.
    if (x === 10 && y === 40) alpha = 127; // Retained rim edge.
    return [0, 0, 0, alpha];
  }, 4);
  const result = await fillSauceboatInterior(source.bytes, cutout.bytes);
  assert.equal(result.filledPixels, 45 * 12);
  const output = (await decoded(result.bytes, true)).data;
  for (let pixel = 0; pixel < 100 * 70; pixel++) {
    const x = pixel % 100, y = Math.floor(pixel / 100);
    assert.deepEqual(output.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
    assert.equal(output[pixel * 4 + 3], x >= 20 && x < 65 && y >= 17 && y < 29 ? 255 : cutout.data[pixel * 4 + 3]);
  }
});

test('a retained sauce surface and one clear peripheral handle gap are left intact', async () => {
  const source = await image(100, 70, () => [245, 185, 30]);
  const cutout = await image(100, 70, (x, y) => [245, 185, 30, x >= 10 && x < 90 && y >= 10 && y < 60 && !(x >= 80 && x < 86 && y >= 15 && y < 36) ? 255 : 0], 4);
  const result = await fillSauceboatInterior(source.bytes, cutout.bytes);
  assert.equal(result.filledPixels, 0);
  assert.deepEqual((await decoded(result.bytes, true)).data, cutout.data);
});

test('sauce boat repair stops on similar-size openings or an open erased food surface', async () => {
  const source = await image(100, 70, () => [245, 185, 30]);
  for (const scenario of ['similar-size', 'open-food', 'single-food'] as const) {
    const cutout = await image(100, 70, (x, y) => {
      let alpha = x >= 10 && x < 90 && y >= 10 && y < 60 ? 255 : 0;
      if (x >= 20 && x < 65 && y >= 17 && y < 29) alpha = 0;
      if (scenario === 'similar-size' && x >= 68 && x < 86 && y >= 15 && y < 41) alpha = 0;
      if (scenario === 'open-food') {
        if (x >= 80 && x < 86 && y >= 15 && y < 36) alpha = 0;
        if (x >= 30 && x < 60 && y < 18) alpha = 0; // The sauce gap reaches the exterior.
      }
      return [245, 185, 30, alpha];
    }, 4);
    await assert.rejects(fillSauceboatInterior(source.bytes, cutout.bytes), failure('PHOTO_MASK_INVALID'), scenario);
  }
});

test('sauce boat repair rejects mismatched pixels and nonopaque sources before restoring food', async () => {
  const source = await image(100, 70, () => [245, 185, 30]);
  const cutout = await image(100, 70, (x, y) => [245, 185, 30, x >= 10 && x < 90 && y >= 10 && y < 60 ? 255 : 0], 4);
  await assert.rejects(fillSauceboatInterior((await image(100, 71, () => [245, 185, 30])).bytes, cutout.bytes), failure('PHOTO_MASK_INVALID'));
  const incomplete = await image(100, 70, (x, y) => [245, 185, 30, x === 50 && y === 30 ? 0 : 255], 4);
  await assert.rejects(fillSauceboatInterior(incomplete.bytes, cutout.bytes), failure('PHOTO_SOURCE_INVALID'));
  await assert.rejects(fillSauceboatInterior(source.bytes, source.bytes), failure('PHOTO_CUTOUT_INVALID'));
});

function cookwareAlpha(x: number, y: number, handles: boolean) {
  let alpha = x >= 25 && x < 95 && y >= 20 && y < 90 ? 255 : 0;
  if (y >= 40 && y < 65 && x >= 5 && x < 115 && (x < 25 || x >= 95)) {
    alpha = !handles || y < 45 || y >= 60 || x < 10 || x >= 110 ? 255 : 0;
  }
  return alpha;
}

test('cookware repair restores one central food opening with solid or open handles, preserving source RGB and other alpha', async () => {
  const source = await image(120, 100, (x, y) => [100 + x, y, x + y]);
  for (const handles of [false, true]) {
    const cutout = await image(120, 100, (x, y) => {
      let alpha = cookwareAlpha(x, y, handles);
      if (x >= 40 && x < 80 && y >= 30 && y < 58) alpha = x === 40 ? 8 : 0;
      if (x === 25 && y === 75) alpha = 127;
      if (x === 85 && y === 75) alpha = 0; // An incidental hole is not food.
      return [0, 0, 0, alpha];
    }, 4);
    const result = await fillCookwareInterior(source.bytes, cutout.bytes);
    assert.equal(result.filledPixels, 40 * 28);
    const output = (await decoded(result.bytes, true)).data;
    for (let pixel = 0; pixel < 120 * 100; pixel++) {
      const x = pixel % 120, y = Math.floor(pixel / 120);
      assert.deepEqual(output.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
      assert.equal(output[pixel * 4 + 3], x >= 40 && x < 80 && y >= 30 && y < 58 ? 255 : cutout.data[pixel * 4 + 3]);
    }
  }
});

test('cookware repair keeps already retained food and peripheral handle holes unchanged', async () => {
  const source = await image(120, 100, () => [180, 110, 30]);
  const cutout = await image(120, 100, (x, y) => [180, 110, 30, cookwareAlpha(x, y, true)], 4);
  const result = await fillCookwareInterior(source.bytes, cutout.bytes);
  assert.equal(result.filledPixels, 0);
  assert.deepEqual((await decoded(result.bytes, true)).data, cutout.data);
});

test('cookware repair rejects comparable central openings and never seals open or diagonal food gaps', async () => {
  const source = await image(120, 100, () => [180, 110, 30]);
  for (const scenario of ['ambiguous', 'open', 'diagonal'] as const) {
    const cutout = await image(120, 100, (x, y) => {
      let alpha = cookwareAlpha(x, y, true);
      if (scenario === 'ambiguous') {
        if ((x >= 30 && x < 58 || x >= 62 && x < 90) && y >= 35 && y < 59) alpha = 0;
      } else {
        if (x >= 40 && x < 80 && y >= 30 && y < 58) alpha = 0;
        if (scenario === 'open' && x >= 50 && x < 65 && y <= 30) alpha = 0;
        if (scenario === 'diagonal' && x - y === 10 && y <= 30) alpha = 0;
      }
      return [180, 110, 30, alpha];
    }, 4);
    await assert.rejects(fillCookwareInterior(source.bytes, cutout.bytes), failure(scenario === 'ambiguous' ? 'PHOTO_MASK_INVALID' : 'PHOTO_CUTOUT_INVALID'), scenario);
  }
});

test('cookware repair rejects mismatched, nonopaque, or invalid sources before restoring food', async () => {
  const source = await image(120, 100, () => [180, 110, 30]);
  const cutout = await image(120, 100, (x, y) => [180, 110, 30, cookwareAlpha(x, y, true)], 4);
  await assert.rejects(fillCookwareInterior((await image(120, 101, () => [180, 110, 30])).bytes, cutout.bytes), failure('PHOTO_MASK_INVALID'));
  const incomplete = await image(120, 100, (x, y) => [180, 110, 30, x === 50 && y === 30 ? 0 : 255], 4);
  await assert.rejects(fillCookwareInterior(incomplete.bytes, cutout.bytes), failure('PHOTO_SOURCE_INVALID'));
  await assert.rejects(fillCookwareInterior(source.bytes, source.bytes), failure('PHOTO_CUTOUT_INVALID'));
});

test('a rim-only ceramic mask cannot pass whole-dish validation', async () => {
  const rim = await image(60, 60, (x, y) => {
    const outer = x >= 10 && x < 50 && y >= 10 && y < 50;
    const inner = x >= 14 && x < 46 && y >= 14 && y < 46;
    return [210, 190, 120, outer && !inner ? 255 : 0];
  }, 4);
  await validateCutout(rim.bytes);
  await assert.rejects(validateSolidHeroCutout(rim.bytes), failure('PHOTO_CUTOUT_INVALID'));
});

test('an explicitly reviewed narrow rim bridge restores only original RGB, then rejects a still-open food gap', async () => {
  const source = await image(60, 60, (x, y) => [x * 3, y * 3, (x + y) * 2]);
  const rim = await image(60, 60, (x, y) => {
    const outer = x >= 10 && x < 50 && y >= 10 && y < 50;
    const inner = x >= 14 && x < 46 && y >= 14 && y < 46;
    const gap = x >= 45 && y >= 27 && y < 29;
    return [0, 0, 0, outer && !inner && !gap ? 255 : 0];
  }, 4);
  const repaired = await fillReviewedHeroSeams(source.bytes, rim.bytes, [{ left: 48, top: 26, width: 2, height: 4 }]);
  assert(repaired.filledPixels > 900); assert.equal(repaired.bridgedPixels, 4);
  const output = (await decoded(repaired.bytes, true)).data;
  for (let pixel = 0; pixel < 3600; pixel++) assert.deepEqual(output.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
  assert.equal(output[(30 * 60 + 30) * 4 + 3], 255);
  assert.equal(output[3], 0);
  await assert.rejects(fillReviewedHeroSeams(source.bytes, rim.bytes, [{ left: 48, top: 26, width: 1, height: 2 }]), failure('PHOTO_CUTOUT_INVALID'));
  await assert.rejects(fillReviewedHeroSeams(source.bytes, rim.bytes, [{ left: 10, top: 10, width: 40, height: 40 }]), failure('PHOTO_MASK_INVALID'));
});

test('reviewed round-vessel outline keeps every source RGB pixel and rejects a clipped or strongly elongated outline', async () => {
  const source = await image(60, 60, (x, y) => [x * 3, y * 3, (x + y) * 2]);
  const corrected = await maskReviewedRoundVessel(source.bytes, { left: 10, top: 10, width: 40, height: 40 });
  const output = (await decoded(corrected.bytes, true)).data;
  for (let pixel = 0; pixel < 3600; pixel++) assert.deepEqual(output.subarray(pixel * 4, pixel * 4 + 3), source.data.subarray(pixel * 3, pixel * 3 + 3));
  assert.equal(output[(30 * 60 + 30) * 4 + 3], 255); assert.equal(output[3], 0);
  assert([...output].some((value, index) => index % 4 === 3 && value > 0 && value < 255));
  await assert.rejects(maskReviewedRoundVessel(source.bytes, { left: 0, top: 0, width: 60, height: 60 }), failure('PHOTO_MASK_INVALID'));
  await assert.rejects(maskReviewedRoundVessel(source.bytes, { left: 10, top: 10, width: 40, height: 20 }), failure('PHOTO_MASK_INVALID'));
});
