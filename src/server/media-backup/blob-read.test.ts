import test from 'node:test';
import assert from 'node:assert/strict';
import { readVerifiedBackupResponse } from './blob';

const pathname = 'vault/v1/test/checkpoints/day/database.json.gz.aesgcm';
const original = Buffer.from('exact encrypted object bytes');
const stored = { pathname, size: original.length, etag: '"object-version-one"', uploadedAt: new Date('2026-10-17T00:00:00Z'), contentType: 'application/octet-stream' };
function response(bytes = original, size = 0, etag = 'W/"object-version-one"') {
  return { stream: new Response(new Uint8Array(bytes)).body!, blob: { ...stored, size, etag },
    headers: new Headers({ 'content-encoding': 'br', 'transfer-encoding': 'chunked' }) };
}

test('chunked Brotli GET has SDK size zero but decoded exact bytes match authoritative HEAD and version', async () => {
  const result = await readVerifiedBackupResponse(pathname, response(), stored, 1024);
  assert.equal(result.size, original.length); assert.equal(result.etag, stored.etag);
  assert.deepEqual(result.bytes, original);
});

test('compressed transfer Content-Length is never mistaken for decoded stored bytes', async () => {
  const result = await readVerifiedBackupResponse(pathname, response(original, 5), stored, 1024);
  assert.equal(result.bytes.length, stored.size);
});

test('HEAD bounds remain strict for truncated, oversized and over-limit streams', async () => {
  await assert.rejects(readVerifiedBackupResponse(pathname, response(original.subarray(1)), stored, 1024), /SIZE_MISMATCH/);
  await assert.rejects(readVerifiedBackupResponse(pathname, response(Buffer.concat([original, Buffer.from('extra')])), stored, 1024), /SIZE_MISMATCH/);
  await assert.rejects(readVerifiedBackupResponse(pathname, response(), stored, original.length - 1), /TOO_LARGE/);
});

test('GET from a different version/path never becomes a verified backup read', async () => {
  await assert.rejects(readVerifiedBackupResponse(pathname, response(original, original.length, '"version-two"'), stored, 1024), /METADATA_MISMATCH/);
  await assert.rejects(readVerifiedBackupResponse(pathname, response(), { ...stored, pathname: 'vault/another.aesgcm' }, 1024), /METADATA_MISMATCH/);
});
