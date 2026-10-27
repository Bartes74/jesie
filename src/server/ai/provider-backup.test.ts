import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readProviderBackup } from './provider-backup';

const id = '12345678-abcd-4bcd-abcd-123456789012';
const bytes = Buffer.from('verified retained provider result');
const manifest = JSON.stringify([{ jobId: id, requestId: 'existing-receipt', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') }]);

test('a provider backup is readable only for its original job and immutable request receipt', async () => {
  let reads = 0;
  const storage = { manifest: async () => manifest, image: async (jobId: string) => { assert.equal(jobId, id); reads++; return bytes; } };
  assert.equal(await readProviderBackup(id, 'another-receipt', storage), null);
  assert.equal(await readProviderBackup('../private-file', 'existing-receipt', storage), null);
  assert.equal(reads, 0);
  assert.equal(await readProviderBackup(id, 'existing-receipt', storage), bytes);
  assert.equal(reads, 1);
});

test('a missing optional recovery package does not impersonate another provider result', async () => {
  assert.equal(await readProviderBackup(id, 'existing-receipt', {
    manifest: async () => { throw Object.assign(new Error('Missing package'), { code: 'ENOENT' }); },
    image: async () => { assert.fail('A missing manifest cannot select a file'); },
  }), null);
});

test('a corrupt recovery file fails integrity checks before it can be used as a photograph', async () => {
  await assert.rejects(readProviderBackup(id, 'existing-receipt', { manifest: async () => manifest,
    image: async () => Buffer.from('unexpected result') }), /INTEGRITY_FAILED/);
});
