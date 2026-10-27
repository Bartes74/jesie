import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobAccessError, BlobError, BlobServiceNotAvailable, BlobServiceRateLimited } from '@vercel/blob';
import { ProviderError } from './provider-error';
import { isTransientPhotoResultRead, photoResultRecoveryError } from './result-recovery-error';

test('only transient receipt downloads and storage service failures allow bounded result retry', () => {
  for (const error of [new BlobServiceNotAvailable(), new BlobServiceRateLimited(), new ProviderError('AI_IMAGE_DOWNLOAD_UNAVAILABLE', 'CDN unavailable', true)]) {
    assert.equal(isTransientPhotoResultRead(error), true);
  }
  for (const error of [new BlobAccessError(), new BlobError('Storage quota exceeded'), new ProviderError('AI_SUBMISSION_UNCERTAIN', 'Acceptance unknown', true), new ProviderError('AI_IMAGE_INVALID', 'Invalid pixels'), new Error('Unknown failure')]) {
    assert.equal(isTransientPhotoResultRead(error), false);
  }
});

test('accepted image storage failures retain uncertainty and show a safe recoverable cause', () => {
  for (const failure of [new BlobAccessError(), new BlobServiceNotAvailable()]) {
    const result = photoResultRecoveryError(failure);
    assert.equal(result?.code, 'AI_RESULT_STORAGE_UNAVAILABLE');
    assert.equal(result?.uncertain, true);
    assert.match(result!.message, /istniejący wynik/);
    assert.doesNotMatch(result!.message, /token|https:/);
  }
});
test('full storage is distinct from an invalid generated photo', () => {
  assert.equal(photoResultRecoveryError(new BlobError('Storage quota exceeded'))?.code, 'AI_RESULT_STORAGE_CAPACITY');
  const invalid = new ProviderError('AI_IMAGE_INVALID', 'Invalid generated pixels');
  assert.equal(photoResultRecoveryError(invalid), invalid);
  assert.equal(photoResultRecoveryError(invalid)?.uncertain, false);
  assert.equal(photoResultRecoveryError(new Error('credential-bearing DB failure')), null);
});
