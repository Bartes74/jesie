import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPrivatePhotoBody } from './photo-blob-body';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const binary = () => Uint8Array.from({ length: 4099 }, (_, index) => index % 256);

test('the upload body preserves every binary byte, MIME type, size and SHA-256', async () => {
  const bytes = binary();
  const body = createPrivatePhotoBody(bytes, 'image/webp');
  const decoded = new Uint8Array(await body.arrayBuffer());
  assert.ok(body instanceof Blob);
  assert.equal(body.type, 'image/webp');
  assert.equal(body.size, bytes.byteLength);
  assert.deepEqual(decoded, bytes);
  assert.equal(sha256(decoded), sha256(bytes));
});

test('each upload retry can independently consume the same body without changing its bytes', async () => {
  const bytes = binary();
  const body = createPrivatePhotoBody(bytes, 'image/png');
  const expected = sha256(bytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Constructing and reading these requests is local; no fetch or provider call occurs.
    const request = new Request('https://example.test/private-image', { method: 'PUT', body });
    const received = new Uint8Array(await request.arrayBuffer());
    assert.equal(request.headers.get('content-type'), 'image/png');
    assert.equal(received.byteLength, bytes.byteLength);
    assert.equal(sha256(received), expected);
  }
  assert.equal(sha256(new Uint8Array(await body.arrayBuffer())), expected);
  const streamed = new Uint8Array(await new Response(body.stream()).arrayBuffer());
  assert.deepEqual(streamed, bytes);
});

test('later mutations of a Buffer, sliced view or backing array cannot change the retained upload body', async () => {
  const backing = Buffer.from(binary());
  const view = backing.subarray(7, 1027);
  const expected = Uint8Array.from(view);
  const body = createPrivatePhotoBody(view, 'image/webp');
  view.fill(0);
  backing.fill(255);
  const retained = new Uint8Array(await body.arrayBuffer());
  assert.equal(body.size, expected.byteLength);
  assert.deepEqual(retained, expected);
  assert.equal(sha256(retained), sha256(expected));
});
