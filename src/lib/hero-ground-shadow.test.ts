import assert from 'node:assert/strict';
import test from 'node:test';
import { heroOpticalLayout, type HeroOpticalLayout } from './hero-optical-layout';
import { heroGroundShadowLayout } from './hero-ground-shadow';

const widePot: HeroOpticalLayout = {
  naturalWidth: 1000, naturalHeight: 1000, boxWidth: 400, boxHeight: 400,
  alphaBounds: { x: 80, y: 300, width: 840, height: 400 }, foregroundArea: 250000,
};
const jar: HeroOpticalLayout = { ...widePot,
  alphaBounds: { x: 300, y: 80, width: 400, height: 840 }, foregroundArea: 250000 };
const close = (actual: number, expected: number) => assert(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
const measure = (input: HeroOpticalLayout) => {
  const result = heroGroundShadowLayout(input, heroOpticalLayout(input));
  assert(result);
  return result;
};

test('a tall jar and wide pot receive a ground shadow at their own visible bottom rather than the frame bottom', () => {
  const potShadow = measure(widePot), jarShadow = measure(jar);
  close(potShadow.centerX, 200); close(jarShadow.centerX, 200);
  close(potShadow.centerY, 292.42857142857144);
  close(jarShadow.centerY, 385);
  close(potShadow.width, 253.44);
  close(jarShadow.width, 115.65714285714286);
  close(potShadow.height, 20); close(jarShadow.height, 20);
  assert(jarShadow.centerY - potShadow.centerY > 90);
});

test('padded cards account for their image content box and asymmetric optical translation', () => {
  const card: HeroOpticalLayout = { ...jar, boxWidth: 320, boxHeight: 260, surface: 'card',
    padding: { left: 24, right: 16, top: 12, bottom: 20 },
    alphaBounds: { x: 200, y: 80, width: 600, height: 840 }, foregroundArea: 380000 };
  const before = structuredClone(card), shadow = measure(card);
  close(shadow.centerX, 160); close(shadow.centerY, 240.2);
  close(shadow.width, 102.96); close(shadow.height, 13);
  assert(shadow.centerY + shadow.height / 2 < card.boxHeight);
  assert.deepEqual(card, before);
});

test('responsive frame and padding changes resize the ground shadow with the same physical subject', () => {
  const small: HeroOpticalLayout = { ...widePot, boxWidth: 320, boxHeight: 200, surface: 'card',
    padding: { left: 24, right: 16, top: 12, bottom: 20 } };
  const large: HeroOpticalLayout = { ...small, boxWidth: 640, boxHeight: 400,
    padding: { left: 48, right: 32, top: 24, bottom: 40 } };
  const first = measure(small), second = measure(large);
  close(second.centerX, first.centerX * 2);
  close(second.centerY - 1, (first.centerY - 1) * 2);
  close(second.width, first.width * 2); close(second.height, first.height * 2);
});

test('natural pixel density and off-centre source canvas do not move the ground shadow away from the dish', () => {
  const baseline = measure(widePot);
  const denser: HeroOpticalLayout = { ...widePot, naturalWidth: 2000, naturalHeight: 2000, foregroundArea: widePot.foregroundArea * 4,
    alphaBounds: { x: 160, y: 600, width: 1680, height: 800 } };
  const offCentre: HeroOpticalLayout = { ...widePot, naturalWidth: 4000, naturalHeight: 3000,
    alphaBounds: { ...widePot.alphaBounds, x: 2400, y: 100 } };
  for (const input of [denser, offCentre]) {
    const shadow = measure(input);
    for (const key of ['centerX', 'centerY', 'width', 'height'] as const) close(shadow[key], baseline[key]);
  }
});

test('ellipse height stays subtle on large frames and has no artificial offset when clearance is tight', () => {
  const large = measure({ ...jar, boxWidth: 1200, boxHeight: 1200 });
  close(large.height, 24);
  const small = measure({ ...jar, boxWidth: 75, boxHeight: 75 });
  close(small.height, 6); close(small.centerY, 72);
  assert(small.centerY + small.height / 2 <= 75);
});

test('invalid source, padding or optical transforms never create a stray shadow', () => {
  const layout = heroOpticalLayout(widePot);
  for (const value of [0, -1, Infinity, NaN]) {
    assert.equal(heroGroundShadowLayout({ ...widePot, naturalWidth: value }, layout), null);
    assert.equal(heroGroundShadowLayout({ ...widePot, boxHeight: value }, layout), null);
    assert.equal(heroGroundShadowLayout({ ...widePot, foregroundArea: value }, layout), null);
    assert.equal(heroGroundShadowLayout(widePot, { ...layout, scale: value }), null);
  }
  for (const input of [
    { ...widePot, alphaBounds: { ...widePot.alphaBounds, x: -1 } },
    { ...widePot, alphaBounds: { ...widePot.alphaBounds, y: 900 } },
    { ...widePot, foregroundArea: 400000 },
    { ...widePot, padding: { left: 400, right: 0, top: 0, bottom: 0 } },
    { ...widePot, padding: { left: 0, right: 0, top: -1, bottom: 0 } },
  ]) assert.equal(heroGroundShadowLayout(input, layout), null);
  for (const invalid of [{ ...layout, originY: NaN }, { ...layout, translateX: Infinity }, { ...layout, translateY: 1000 }])
    assert.equal(heroGroundShadowLayout(widePot, invalid), null);
});
