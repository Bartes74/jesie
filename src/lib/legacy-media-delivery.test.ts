import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaDeliveryWidths } from './media-delivery';
import { isLegacyMediaSource, legacyMediaAtlasMaximumWidth, legacyMediaDeliverySrc, legacyMediaDeliverySrcSet, legacyMediaRelativePath, parseLegacyMediaDeliveryWidth } from './legacy-media-delivery';

test('safe raster files use full-atlas versioned delivery with each shared responsive width', () => {
  for (const source of ['/images/ingredients-1.webp', '/images/steps/one.png', '/images/dish.jpg', '/images/dish.jpeg', '/images/Archive/DISH.jpg']) {
    assert.equal(isLegacyMediaSource(source), true);
    const path = legacyMediaRelativePath(source);
    for (const width of mediaDeliveryWidths) {
      const url = legacyMediaDeliverySrc(source, width);
      assert.equal(url, `/media/static/${path}?w=${width}&d=1`);
      assert.equal(parseLegacyMediaDeliveryWidth(new URL(url, 'https://www.jesie.pl').searchParams), width);
    }
  }
});

test('query-bearing, remote, traversal and unsupported sources remain unchanged instead of entering a file route', () => {
  for (const source of ['/images/a.webp?secret=1', '/images/a.webp#tile', '/images/../secret.webp', '/images/./a.webp', '/images//a.webp', '/images/%2e%2e/a.webp', '/images/a%2fb.webp', '/images/a\\b.webp', '//images/a.webp', 'https://example.invalid/images/a.webp', '/media/id', '/images/.env', '/images/a.svg', '/images/a.gif', '/images/a.JPG', '/images/a.webp\n', `/images/${'a'.repeat(500)}.webp`]) {
    assert.equal(legacyMediaRelativePath(source), null, source);
    assert.equal(legacyMediaDeliverySrc(source, 640), source);
    assert.equal(legacyMediaDeliverySrcSet(source), undefined);
  }
});

test('responsive sets respect the requested cap and route rejects ambiguous versions and widths', () => {
  const source = '/images/ingredients-1.webp';
  assert.equal(legacyMediaDeliverySrcSet(source, 320), [96, 160, 320].map(width => `/media/static/ingredients-1.webp?w=${width}&d=1 ${width}w`).join(', '));
  for (const query of ['', 'w=320', 'd=1', 'w=320&d=2', 'w=320&d=1&d=1', 'w=320&w=640&d=1', 'w=0320&d=1', 'w=320.0&d=1', 'w=80&d=1', 'w=320&d=', 'w=&d=1']) assert.equal(parseLegacyMediaDeliveryWidth(new URLSearchParams(query)), null, query);
});

test('legacy atlas caps preserve photo detail across scaled atlas viewports without exceeding 1600', () => {
  assert.equal(legacyMediaAtlasMaximumWidth(320, 448), 1600);
  assert.equal(legacyMediaAtlasMaximumWidth(160, 448), 960);
  assert.equal(legacyMediaAtlasMaximumWidth(320, 204), 960);
  assert.equal(legacyMediaAtlasMaximumWidth(1600, 204), 1600);
  assert.equal(legacyMediaAtlasMaximumWidth(320, 100), 320);
  assert.equal(legacyMediaAtlasMaximumWidth(320, NaN), 320);
});
