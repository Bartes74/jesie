import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaDeliveryResponse } from './delivery-response';
const image = { bytes: Buffer.from('verified pixels'), width: 160, height: 160 };

test('public delivery has an exact pixel ETag and reduces matching repeat transfers to 304', async () => {
  const first = mediaDeliveryResponse({ ...image, public: true }, new Headers());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Content-Length'), String(image.bytes.length));
  const tag = first.headers.get('ETag')!;
  assert.match(tag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), image.bytes);
  for (const value of [tag, `W/${tag}`, `"other", ${tag}`]) {
    const response = mediaDeliveryResponse({ ...image, public: true }, new Headers({ 'If-None-Match': value }));
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  assert.equal(mediaDeliveryResponse({ ...image, bytes: Buffer.from('changed pixels'), public: true }, new Headers({ 'If-None-Match': tag })).status, 200);
});

test('a draft thumbnail is never reusable through HTTP cache or conditional public state', () => {
  const publicTag = mediaDeliveryResponse({ ...image, public: true }, new Headers()).headers.get('ETag')!;
  const response = mediaDeliveryResponse({ ...image, public: false }, new Headers({ 'If-None-Match': publicTag }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});
