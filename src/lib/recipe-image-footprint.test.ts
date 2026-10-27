import assert from 'node:assert/strict';
import test from 'node:test';
import { measureRecipeImageFootprint } from './recipe-image-footprint';

function sample(alpha: (x: number, y: number) => number, naturalWidth = 200, naturalHeight = 200) {
  const pixels = new Uint8ClampedArray(20 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) pixels[(y * 20 + x) * 4 + 3] = alpha(x, y);
  return { pixels, width: 20, height: 20, naturalWidth, naturalHeight };
}

test('the same vessel has the same physical footprint at every translucency', () => {
  const shape = (x: number, y: number) => x >= 6 && x < 14 && y >= 2 && y < 18;
  const opaque = measureRecipeImageFootprint(sample((x, y) => shape(x, y) ? 255 : 0));
  assert(opaque);
  for (const alpha of [1, 32, 128]) {
    assert.deepEqual(measureRecipeImageFootprint(sample((x, y) => shape(x, y) ? alpha : 0)), opaque);
  }
  assert.equal(opaque.foregroundArea, 8 * 16 * 100);
});

test('a non-square source converts sample area and the guarded outline into natural coordinates', () => {
  const result = measureRecipeImageFootprint(sample((x, y) => x >= 4 && x < 16 && y >= 6 && y < 14 ? 255 : 0, 400, 200));
  assert.deepEqual(result, { bounds: { x: 60, y: 50, width: 280, height: 100 }, foregroundArea: 12 * 8 * 20 * 10 });
});

test('transparent handles and gaps count as empty space without losing their outer rim', () => {
  const solid = measureRecipeImageFootprint(sample((x, y) => x >= 3 && x <= 16 && y >= 5 && y <= 14 ? 255 : 0));
  const hollow = measureRecipeImageFootprint(sample((x, y) => {
    const outside = x >= 3 && x <= 16 && y >= 5 && y <= 14;
    return outside && !(x >= 4 && x <= 6 && y >= 7 && y <= 12) ? 255 : 0;
  }));
  assert(solid && hollow);
  assert.deepEqual(hollow.bounds, solid.bounds);
  assert.equal(solid.foregroundArea - hollow.foregroundArea, 3 * 6 * 100);
});

test('every faint retained edge contributes to the safe outline', () => {
  const result = measureRecipeImageFootprint(sample((x, y) => {
    if (x === 1 && y === 10) return 1;
    return x >= 5 && x < 15 && y >= 5 && y < 15 ? 255 : 0;
  }));
  assert(result);
  assert.equal(result.bounds.x, 0);
  assert.equal(result.foregroundArea, 101 * 100);
});

test('opaque photos, empty masks, trivial noise and malformed samples keep their original layout', () => {
  for (const alpha of [() => 255, () => 0, (x: number, y: number) => x === 10 && y === 10 ? 255 : 0]) {
    assert.equal(measureRecipeImageFootprint(sample(alpha)), null);
  }
  assert.equal(measureRecipeImageFootprint(sample((x, y) =>
    (x < 3 || x > 16) && (y < 3 || y > 16) ? 0 : 255)), null, 'Rounded corners do not turn a full editorial frame into a cutout.');
  const valid = sample((x, y) => x > 4 && x < 15 && y > 4 && y < 15 ? 255 : 0);
  assert.equal(measureRecipeImageFootprint({ ...valid, pixels: new Uint8Array(10) }), null);
  assert.equal(measureRecipeImageFootprint({ ...valid, naturalWidth: NaN }), null);
  assert.equal(measureRecipeImageFootprint({ ...valid, width: 193 }), null);
});
