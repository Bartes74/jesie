import assert from 'node:assert/strict';
import test from 'node:test';
import { heroOpticalLayout, type HeroOpticalLayout, type HeroOpticalTransform } from './hero-optical-layout';

const roundPlate: HeroOpticalLayout = {
  naturalWidth: 1000, naturalHeight: 1000,
  boxWidth: 704, boxHeight: 620,
  alphaBounds: { x: 40, y: 40, width: 920, height: 920 },
  foregroundArea: Math.PI * 460 ** 2,
};
const cookware: HeroOpticalLayout = { ...roundPlate,
  alphaBounds: { x: 40, y: 171, width: 920, height: 658 }, foregroundArea: 417000 };
const card: HeroOpticalLayout = { ...cookware, boxWidth: 409, boxHeight: 358,
  padding: { left: 26, right: 26, top: 26, bottom: 26 }, surface: 'card' };

const close = (actual: number, expected: number) => assert(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

function content(input: HeroOpticalLayout) {
  const padding = input.padding ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const width = input.boxWidth - padding.left - padding.right;
  const height = input.boxHeight - padding.top - padding.bottom;
  const contain = Math.min(width / input.naturalWidth, height / input.naturalHeight);
  return { width, height, contain,
    left: padding.left + (width - input.naturalWidth * contain) / 2,
    top: padding.top + (height - input.naturalHeight * contain) / 2 };
}

function transformedCorners(input: HeroOpticalLayout, layout: HeroOpticalTransform, hover = false) {
  const base = content(input);
  const { x, y, width, height } = input.alphaBounds;
  const angle = hover ? -Math.PI / 180 : 0;
  const scale = layout.scale * (hover ? 1.045 : 1);
  return [x, x + width].flatMap(naturalX => [y, y + height].map(naturalY => {
    const dx = base.left + naturalX * base.contain - layout.originX;
    const dy = base.top + naturalY * base.contain - layout.originY;
    return {
      x: layout.originX + layout.translateX + (dx * Math.cos(angle) - dy * Math.sin(angle)) * scale,
      y: layout.originY + layout.translateY + (dx * Math.sin(angle) + dy * Math.cos(angle)) * scale,
    };
  }));
}

function assertSafe(input: HeroOpticalLayout, layout: HeroOpticalTransform) {
  const horizontalMargin = input.surface === 'card' ? 0.05 : 0.02;
  const verticalMargin = input.surface === 'card' ? 0.08 : 0.04;
  const points = transformedCorners(input, layout);
  for (const point of points) {
    assert(point.x + 1e-8 >= input.boxWidth * horizontalMargin, 'left handle retains its margin');
    assert(point.x <= input.boxWidth * (1 - horizontalMargin) + 1e-8, 'right handle retains its margin');
    assert(point.y + 1e-8 >= input.boxHeight * verticalMargin, 'top retains its margin');
    assert(point.y <= input.boxHeight * (1 - verticalMargin) + 1e-8, 'bottom retains its margin');
  }
  close((Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))) / 2, input.boxWidth / 2);
  close((Math.min(...points.map(point => point.y)) + Math.max(...points.map(point => point.y))) / 2, input.boxHeight / 2);
}

function renderedArea(input: HeroOpticalLayout, layout: HeroOpticalTransform) {
  return input.foregroundArea * (content(input).contain * layout.scale) ** 2;
}

function targetArea(input: HeroOpticalLayout) {
  return Math.PI * (0.92 / 2) ** 2 * Math.min(content(input).width, content(input).height) ** 2;
}

function assertSafeHover(input: HeroOpticalLayout, layout: HeroOpticalTransform) {
  for (const point of transformedCorners(input, layout, true)) {
    assert(point.x >= 0 && point.x <= input.boxWidth, 'hover retains the complete handle');
    assert(point.y >= 0 && point.y <= input.boxHeight, 'hover retains the complete rim');
  }
}

test('a normalized round plate retains the established size on hero and padded cards', () => {
  for (const input of [roundPlate, { ...card, alphaBounds: roundPlate.alphaBounds, foregroundArea: roundPlate.foregroundArea }]) {
    const layout = heroOpticalLayout(input);
    close(layout.scale, 1);
    close(layout.translateX, 0); close(layout.translateY, 0);
    close(renderedArea(input, layout), targetArea(input));
    assertSafe(input, layout);
  }
});

test('wide cookware matches the plate area on a card without a fixed enlargement cap', () => {
  const layout = heroOpticalLayout(card);
  assert(layout.scale > 1.25);
  close(renderedArea(card, layout), targetArea(card));
  assertSafe(card, layout);
  assertSafeHover(card, layout);
});

test('hero cookware stops at its complete handles when the target area cannot fit', () => {
  const layout = heroOpticalLayout(cookware);
  const points = transformedCorners(cookware, layout);
  close(Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)), cookware.boxWidth * 0.96);
  assert(renderedArea(cookware, layout) < targetArea(cookware));
  assertSafe(cookware, layout);
});

test('a mobile card uses padding in contain sizing and retains every handle during hover', () => {
  const input: HeroOpticalLayout = { ...card, boxWidth: 335, boxHeight: 266,
    padding: { left: 21, right: 21, top: 21, bottom: 21 } };
  const layout = heroOpticalLayout(input);
  close(renderedArea(input, layout), targetArea(input));
  assertSafe(input, layout);
  assertSafeHover(input, layout);
});

test('a tall jar and thin bottle retain their full height instead of chasing an impossible plate area', () => {
  for (const [width, foregroundArea] of [[600, 450000], [180, 130000]]) {
    const input: HeroOpticalLayout = { ...roundPlate,
      alphaBounds: { x: (1000 - width) / 2, y: 40, width, height: 920 }, foregroundArea };
    const layout = heroOpticalLayout(input);
    close(layout.scale, 1);
    assert(renderedArea(input, layout) < targetArea(input));
    assertSafe(input, layout);
  }
});

test('a tall jar on a card uses available height and remains complete through hover', () => {
  const input: HeroOpticalLayout = { ...card, alphaBounds: { x: 200, y: 40, width: 600, height: 920 }, foregroundArea: 450000 };
  const layout = heroOpticalLayout(input);
  assert(layout.scale > 1);
  const points = transformedCorners(input, layout);
  close(Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)), input.boxHeight * 0.84);
  assertSafe(input, layout);
  assertSafeHover(input, layout);
});

test('a broad sauceboat preserves its spout and handle at the frame limit', () => {
  const input: HeroOpticalLayout = { ...roundPlate,
    alphaBounds: { x: 40, y: 300, width: 920, height: 400 }, foregroundArea: 250000 };
  const layout = heroOpticalLayout(input);
  close(layout.scale, heroOpticalLayout(cookware).scale);
  assert(renderedArea(input, layout) < targetArea(input));
  assertSafe(input, layout);
});

test('large empty exterior canvas and off-centre placement produce the same visible dish', () => {
  const input: HeroOpticalLayout = { ...card, naturalWidth: 4000, naturalHeight: 3000,
    alphaBounds: { ...card.alphaBounds, x: 2400, y: 100 } };
  const layout = heroOpticalLayout(input);
  const original = heroOpticalLayout(card);
  assert(layout.scale > 4);
  assert(Math.abs(layout.translateX) > 50 && Math.abs(layout.translateY) > 50);
  close(renderedArea(input, layout), renderedArea(card, original));
  const points = transformedCorners(input, layout), baseline = transformedCorners(card, original);
  points.forEach((point, index) => { close(point.x, baseline[index].x); close(point.y, baseline[index].y); });
  assertSafe(input, layout);
  assertSafeHover(input, layout);
});

test('asymmetric padding and off-centre silhouettes rotate and scale about the actual dish centre', () => {
  const input: HeroOpticalLayout = { ...card, padding: { left: 70, right: 10, top: 45, bottom: 7 },
    alphaBounds: { x: 80, y: 171, width: 900, height: 658 }, foregroundArea: 410000 };
  const layout = heroOpticalLayout(input);
  close(layout.originX, 243.68); close(layout.originY, 198);
  close(layout.translateX, -39.18); close(layout.translateY, -19);
  close(renderedArea(input, layout), targetArea(input));
  assertSafe(input, layout);
  assertSafeHover(input, layout);
});

test('dense oversized silhouettes shrink to the reference area rather than violating the frame', () => {
  const input: HeroOpticalLayout = { ...roundPlate,
    alphaBounds: { x: 0, y: 0, width: 1000, height: 1000 }, foregroundArea: 1000000 };
  const layout = heroOpticalLayout(input);
  assert(layout.scale < 0.82);
  close(renderedArea(input, layout), targetArea(input));
  assertSafe(input, layout);
});

test('a sparse silhouette also shrinks when its full outer bounds exceed the available frame', () => {
  const input: HeroOpticalLayout = { ...roundPlate, naturalWidth: 1600, naturalHeight: 900,
    alphaBounds: { x: 0, y: 0, width: 1600, height: 900 }, foregroundArea: 300000 };
  const layout = heroOpticalLayout(input);
  close(layout.scale, 0.96);
  assert(renderedArea(input, layout) < targetArea(input));
  assertSafe(input, layout);
});

test('natural pixel density does not change the dish presentation', () => {
  const resized: HeroOpticalLayout = { ...card, naturalWidth: 2000, naturalHeight: 2000, foregroundArea: card.foregroundArea * 4,
    alphaBounds: { x: 80, y: 342, width: 1840, height: 1316 } };
  assert.deepEqual(heroOpticalLayout(resized), heroOpticalLayout(card));
});

test('invalid geometry and area retain the original layout with a finite frame-centre origin', () => {
  const invalid: HeroOpticalLayout[] = [];
  for (const value of [0, -1, Infinity, NaN]) {
    invalid.push({ ...card, naturalWidth: value }, { ...card, boxHeight: value }, { ...card, foregroundArea: value });
  }
  invalid.push(
    { ...card, foregroundArea: card.alphaBounds.width * card.alphaBounds.height + 1 },
    { ...card, alphaBounds: { x: -1, y: 0, width: 920, height: 658 } },
    { ...card, alphaBounds: { x: 0, y: NaN, width: 920, height: 658 } },
    { ...card, alphaBounds: { x: 200, y: 0, width: 920, height: 658 } },
    { ...card, alphaBounds: { x: 0, y: 600, width: 920, height: 658 } },
    { ...card, padding: { left: -1, right: 0, top: 0, bottom: 0 } },
    { ...card, padding: { left: 0, right: Infinity, top: 0, bottom: 0 } },
    { ...card, padding: { left: 0, right: 0, top: NaN, bottom: 0 } },
    { ...card, padding: { left: 200, right: 209, top: 0, bottom: 0 } },
    { ...card, padding: { left: 0, right: 0, top: 200, bottom: 200 } },
  );
  for (const input of invalid) {
    assert.deepEqual(heroOpticalLayout(input), { scale: 1, translateX: 0, translateY: 0,
      originX: Number.isFinite(input.boxWidth) ? input.boxWidth / 2 : 0,
      originY: Number.isFinite(input.boxHeight) ? input.boxHeight / 2 : 0 });
  }
});
