import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegisteredMediaSource, mediaDeliverySrc, mediaDeliverySrcSet, mediaDeliveryWidths, parseMediaDeliveryWidth } from './media-delivery';

const src = '/media/c9fa7908-1c65-4e5d-9afc-66a1928cd227';

test('all supported media widths use one immutable source identity and a versioned delivery URL', () => {
  assert.equal(isRegisteredMediaSource(src), true);
  for (const width of mediaDeliveryWidths) {
    const target = mediaDeliverySrc(src, width);
    assert.equal(target, `${src}?w=${width}&d=2`);
    assert.equal(parseMediaDeliveryWidth(new URL(target, 'https://www.jesie.pl').searchParams), width);
  }
});

test('parser retains full-frame access and legacy widths while rejecting unsupported or ambiguous variants', () => {
  assert.equal(parseMediaDeliveryWidth(new URLSearchParams()), undefined);
  assert.equal(parseMediaDeliveryWidth(new URLSearchParams('utm_source=review')), undefined);
  for (const width of mediaDeliveryWidths) assert.equal(parseMediaDeliveryWidth(new URLSearchParams(`w=${width}`)), width);
  for (const query of ['d=2', 'd=1', 'w=80', 'w=096', 'w=1600.0', 'w=', 'w=-320', 'w=999999', 'w=320&w=640', 'w=320&w=320', 'w=320&d=2&d=2', 'w=320&d=1', 'w=320&d=', 'w=320&d=2&d=1']) {
    assert.equal(parseMediaDeliveryWidth(new URLSearchParams(query)), null, query);
  }
});

test('responsive sets cap thumbnails and previews without changing or repeating the asset ID', () => {
  for (const maximumWidth of [160, 320, 1280, 1600] as const) {
    const candidates = mediaDeliverySrcSet(src, maximumWidth)!.split(', ');
    const widths = candidates.map(item => Number(item.split(' ').at(-1)!.slice(0, -1)));
    assert.deepEqual(widths, mediaDeliveryWidths.filter(width => width <= maximumWidth));
    assert.equal(new Set(candidates).size, candidates.length);
    for (const candidate of candidates) assert.match(candidate, new RegExp(`^${src}\\?w=\\d+&d=2 \\d+w$`));
  }
});

test('static images, malformed IDs, query-bearing paths and external URLs cannot become authenticated derivative URLs', () => {
  for (const original of ['/images/ingredients-1.webp', '/media/not-a-uuid', `${src}?original=1`, `${src}#photo`, `${src}/extra`, 'https://private.invalid/media/c9fa7908-1c65-4e5d-9afc-66a1928cd227', '/media/../../secret']) {
    assert.equal(isRegisteredMediaSource(original), false);
    assert.equal(mediaDeliverySrc(original, 320), original);
    assert.equal(mediaDeliverySrcSet(original), undefined);
  }
});
