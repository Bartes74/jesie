import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticMediaRoute } from './static-delivery-route';

test('static route returns versioned public bytes and conditional 304 with one content ETag', async () => {
  const bytes = Buffer.from('verified photo fixture'); let calls = 0;
  const route = createStaticMediaRoute(async (src, width) => {
    assert.equal(src, '/images/ingredients-1.webp'); assert.equal(width, 160); calls++;
    return { bytes, width: 160, height: 120 };
  });
  const context = { params: Promise.resolve({ path: ['ingredients-1.webp'] }) };
  const first = await route(new Request('https://jesie.pl/media/static/ingredients-1.webp?w=160&d=1'), context);
  assert.equal(first.status, 200); assert.equal(first.headers.get('Content-Type'), 'image/webp');
  assert.match(first.headers.get('Cache-Control')!, /s-maxage=300/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes);
  const second = await route(new Request('https://jesie.pl/media/static/ingredients-1.webp?w=160&d=1', {
    headers: { 'If-None-Match': first.headers.get('ETag')! },
  }), context);
  assert.equal(second.status, 304); assert.equal((await second.arrayBuffer()).byteLength, 0); assert.equal(calls, 2);
});

test('static route rejects ambiguous sizes, private paths and traversal before source access', async () => {
  let calls = 0;
  const route = createStaticMediaRoute(async () => { calls++; throw new Error('Source access forbidden'); });
  for (const query of ['', '?w=160', '?w=160&d=2', '?w=160&d=1&w=320', '?w=160&d=1&other=1', '?w=161&d=1']) {
    const response = await route(new Request(`https://jesie.pl/media/static/test.webp${query}`), { params: Promise.resolve({ path: ['test.webp'] }) });
    assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  for (const parts of [['..', 'private.webp'], ['%2e%2e', 'private.webp'], ['secret.svg'], [''], ['test.webp?remote=1']]) {
    assert.equal((await route(new Request('https://jesie.pl/media/static/test.webp?w=160&d=1'), { params: Promise.resolve({ path: parts }) })).status, 404);
  }
  assert.equal(calls, 0);
});
