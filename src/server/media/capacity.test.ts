import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { ensurePhotoStorageAvailable, hobbyMaximumBytes, imageCapacityHeadroom, photoStorageMaximumBytes } from './capacity';
import { ProviderError } from '@/server/ai/provider-error';

const previousMaximum = process.env.BLOB_STORAGE_LIMIT_BYTES;
beforeEach(() => { delete process.env.BLOB_STORAGE_LIMIT_BYTES; });
afterEach(() => {
  if (previousMaximum === undefined) delete process.env.BLOB_STORAGE_LIMIT_BYTES;
  else process.env.BLOB_STORAGE_LIMIT_BYTES = previousMaximum;
});

test('the absent local guard remains a conservative one gigabyte', () => {
  assert.equal(photoStorageMaximumBytes(), 1_000_000_000);
  assert.equal(photoStorageMaximumBytes('10000000000'), 10_000_000_000);
});

test('invalid explicit guard fails closed before any storage or paid-provider work', async () => {
  for (const invalid of ['', ' ', 'Infinity', 'NaN', '1e10', '10000000000.0', '0', '-1', '+10000000000', ' 10000000000', '10000000000\n', '9007199254740992', String(imageCapacityHeadroom)]) {
    process.env.BLOB_STORAGE_LIMIT_BYTES = invalid;
    let touchedStorage = false;
    await assert.rejects(ensurePhotoStorageAvailable({
      list: async () => { touchedStorage = true; return { blobs: [], hasMore: false }; },
      read: async () => { touchedStorage = true; return null; },
    }), error => error instanceof ProviderError && error.code === 'AI_STORAGE_CONFIGURATION' && !error.uncertain);
    assert.equal(touchedStorage, false, JSON.stringify(invalid));
  }
});

test('the verified Pro local guard admits the real 936 MB inventory and still requires fresh read access', async () => {
  process.env.BLOB_STORAGE_LIMIT_BYTES = '10000000000';
  const cursors: (string | undefined)[] = [];
  let cancelled = false, reads = 0;
  await ensurePhotoStorageAvailable({
    list: async cursor => { cursors.push(cursor); return cursor
      ? { blobs: [{ pathname: 'ai/compact/retained.webp', size: 431_758_128 }], hasMore: false }
      : { blobs: [{ pathname: 'ai/retained.webp', size: 504_405_079 }], hasMore: true, cursor: 'next' }; },
    read: async pathname => { reads++; assert.equal(pathname, 'ai/retained.webp'); return { statusCode: 200, stream: new ReadableStream({ cancel() { cancelled = true; } }) }; },
  });
  assert.deepEqual(cursors, [undefined, 'next']);
  assert.equal(reads, 1); assert.equal(cancelled, true);
  await assert.rejects(ensurePhotoStorageAvailable({
    list: async () => ({ blobs: [{ pathname: 'ai/retained.webp', size: 936_163_207 }], hasMore: false }),
    read: async () => null,
  }), error => error instanceof ProviderError && error.code === 'AI_STORAGE_UNAVAILABLE');
});

test('the configured guard keeps exactly 64 MiB of headroom and blocks one byte above it', async () => {
  process.env.BLOB_STORAGE_LIMIT_BYTES = '10000000000';
  let reads = 0;
  const dependencies = (size: number) => ({
    list: async () => ({ blobs: [{ pathname: 'ai/retained.webp', size }], hasMore: false }),
    read: async () => { reads++; return { statusCode: 200, stream: new ReadableStream<Uint8Array>() }; },
  });
  await ensurePhotoStorageAvailable(dependencies(10_000_000_000 - imageCapacityHeadroom));
  await assert.rejects(ensurePhotoStorageAvailable(dependencies(10_000_000_000 - imageCapacityHeadroom + 1)),
    error => error instanceof ProviderError && error.code === 'AI_STORAGE_CAPACITY' && !error.uncertain);
  assert.equal(reads, 1);
});

test('all inventory pages count before admitting another paid photograph', async () => {
  const cursors: (string | undefined)[] = [];
  let reads = 0;
  await assert.rejects(ensurePhotoStorageAvailable({
    list: async cursor => { cursors.push(cursor); return cursor
      ? { blobs: [{ pathname: 'ai/two', size: 100 }], hasMore: false }
      : { blobs: [{ pathname: 'ai/one', size: hobbyMaximumBytes - imageCapacityHeadroom - 50 }], hasMore: true, cursor: 'next' }; },
    read: async () => { reads++; return null; },
  }), error => error instanceof ProviderError && error.code === 'AI_STORAGE_CAPACITY' && !error.uncertain);
  assert.deepEqual(cursors, [undefined, 'next']); assert.equal(reads, 0);
});

test('a suspended store blocks paid work even with sufficient listed free space', async () => {
  await assert.rejects(ensurePhotoStorageAvailable({
    list: async () => ({ blobs: [{ pathname: 'ai/source', size: 100 }], hasMore: false }),
    read: async () => { throw new Error('Your store is blocked'); },
  }), error => error instanceof ProviderError && error.code === 'AI_STORAGE_UNAVAILABLE' && !error.uncertain);
});

test('an accessible store with headroom cancels its probe stream before returning', async () => {
  let cancelled = false;
  await ensurePhotoStorageAvailable({
    list: async () => ({ blobs: [{ pathname: 'ai/source', size: 100 }], hasMore: false }),
    read: async () => ({ statusCode: 200, stream: new ReadableStream({ cancel() { cancelled = true; } }) }),
  });
  assert.equal(cancelled, true);
});
