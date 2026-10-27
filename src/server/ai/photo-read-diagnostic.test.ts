import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@fal-ai/client';
import { BlobError } from '@vercel/blob';
import { ProviderError } from './provider-error';
import { photoReadDiagnostic, photoReadRedirectBlocked, withPhotoReadStage, type PhotoReadDiagnostic } from './photo-read-diagnostic';

const context = { jobId: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', requestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', stage: 'provider-result' as const };

test('accepted-result 422 and transient responses remain distinct without logging body, message or authentication', () => {
  for (const [status, disposition] of [[422, 'request-rejected'], [503, 'retryable-response'], [429, 'retryable-response'], [403, 'access-denied']] as const) {
    const error = new ApiError({ status, message: 'Key secret-private-key https://private.invalid', body: { prompt: 'private recipe prompt', token: 'secret-token', image_url: 'https://private.invalid/image' } });
    const diagnostic = photoReadDiagnostic(context, error);
    assert.equal(diagnostic.httpStatus, status); assert.equal(diagnostic.httpDisposition, disposition);
    assert.equal(diagnostic.errorClass, 'ApiError'); assert.equal(diagnostic.stage, 'provider-result');
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private|https|prompt|token|message|body/);
    assert.equal('chargedUsd' in diagnostic, false); assert.equal('terminal' in diagnostic, false);
  }
});

test('the wrapper calls its operation once and preserves an accepted receipt error and conservative charge', async () => {
  let calls = 0; const reports: PhotoReadDiagnostic[] = [];
  const error = new ProviderError('AI_IMAGE_DOWNLOAD_UNAVAILABLE', 'private message', true, '0.10000000');
  await assert.rejects(withPhotoReadStage({ ...context, stage: 'mask-download' }, () => { calls++; throw error; }, diagnostic => reports.push(diagnostic)), value => value === error);
  assert.equal(calls, 1); assert.equal(error.uncertain, true); assert.equal(error.chargedUsd, '0.10000000');
  assert.equal(reports.length, 1); assert.equal(reports[0].code, 'AI_IMAGE_DOWNLOAD_UNAVAILABLE');
});

test('a successful operation and a failed logger cannot change provider processing', async () => {
  assert.equal(await withPhotoReadStage(context, async () => 7, () => assert.fail('Success should not log.')), 7);
  const error = new Error('private query');
  await assert.rejects(withPhotoReadStage(context, () => { throw error; }, () => { throw new Error('Log failure'); }), value => value === error);
});

test('storage and nested database failures expose only their stage and allowlisted diagnostic', () => {
  const storage = photoReadDiagnostic({ ...context, stage: 'photo-save' }, new BlobError('Failed to fetch blob: 503 confidential extra data'));
  assert.equal(storage.errorClass, 'BlobError'); assert.equal(storage.httpStatus, 503); assert.equal(storage.stage, 'photo-save');
  const cause = Object.assign(new Error('postgres://private-password'), { code: '53000' });
  const database = photoReadDiagnostic({ ...context, stage: 'source-read' }, new Error('private SQL', { cause }));
  assert.equal(database.code, '53000'); assert.equal(database.stage, 'source-read');
  assert.doesNotMatch(JSON.stringify([storage, database]), /confidential|postgres|password|SQL|private/);
});

test('arbitrary codes, error names and request IDs cannot carry secrets into diagnostics', () => {
  const error = Object.assign(new Error('private'), { name: 'SECRET_KEY', code: 'SECRET_KEY' });
  assert.deepEqual(photoReadDiagnostic({ ...context, jobId: 'secret-token', requestId: 'secret-token' }, error), { event: 'photo_result_read_failed', stage: 'provider-result', errorClass: 'Error' });
});

test('the redirect marker requires the exact fixed TypeError cause and cannot match arbitrary provider text', () => {
  assert.equal(photoReadRedirectBlocked(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })), true);
  assert.equal(photoReadRedirectBlocked(new TypeError('fetch failed', { cause: new Error('unexpected redirect https://private.invalid') })), false);
  assert.equal(photoReadRedirectBlocked(new Error('unexpected redirect')), false);
  assert.equal(photoReadRedirectBlocked(new TypeError('unexpected redirect')), false);
});

test('bundle diagnostics retain at most two distinct verified-format chunk locations and redact full paths and messages', () => {
  const error = new TypeError('private token https://secret.invalid/image');
  error.stack = [
    'TypeError: private token https://secret.invalid/image',
    '    at secretFunction (/var/task/private-token/.next/server/chunks/[root-of-the-server]__0qflc76._.js:1:199)',
    '    at duplicate (/var/task/private-token/.next/server/chunks/[root-of-the-server]__0qflc76._.js:1:199)',
    '    at anotherSecret (/Users/private/.next/server/chunks/ssr/[root-of-the-server]__05_4fkg._.js:23:10)',
    '    at omitted (/var/task/.next/server/chunks/[root-of-the-server]__1qkfy9r._.js:9:7)',
  ].join('\n');
  const diagnostic = photoReadDiagnostic({ ...context, stage: 'photo-archive-read' }, error);
  assert.equal(diagnostic.errorClass, 'TypeError');
  assert.deepEqual(diagnostic.bundleFrames, [
    { file: '[root-of-the-server]__0qflc76._.js', line: 1, column: 199 },
    { file: '[root-of-the-server]__05_4fkg._.js', line: 23, column: 10 },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|token|https|var\/task|Users|Function|stack|message/);
});

test('nested causes expose safe base36 and numeric chunk identifiers with bounded positions', () => {
  const cause = Object.assign(new TypeError('private cause'), { code: 'UND_ERR_INVALID_ARG', stack: [
    'TypeError: private cause',
    '    at nested (.next/server/chunks/[root-of-the-server]__1qkfy9r._.js:9:7)',
    '    at /var/task/.next/server/chunks/123.js:3:44',
  ].join('\n') });
  const diagnostic = photoReadDiagnostic({ ...context, stage: 'photo-web-upload' }, new Error('private SQL', { cause }));
  assert.equal(diagnostic.code, 'UND_ERR_INVALID_ARG');
  assert.deepEqual(diagnostic.bundleFrames, [
    { file: '[root-of-the-server]__1qkfy9r._.js', line: 9, column: 7 },
    { file: '123.js', line: 3, column: 44 },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|SQL|nested|var\/task|stack|cause/);
});

test('remote URLs, arbitrary secret filenames, non-chunks and invalid positions never become bundle frames', () => {
  const error = new TypeError('private message');
  error.stack = [
    'TypeError: private message',
    '    at remote (https://secret.invalid/.next/server/chunks/[root-of-the-server]__0qflc76._.js:1:2)',
    '    at remote (//secret.invalid/.next/server/chunks/[root-of-the-server]__0qflc76._.js:1:2)',
    '    at uri (file:///private/.next/server/chunks/[root-of-the-server]__0qflc76._.js:1:2)',
    '    at /private/.next/server/chunks/123.js?token=secret:1:2',
    '    at /private/.next/server/chunks/secret_token_fedc1234.js:1:2',
    '    at /private/.next/server/chunks/[turbopack]_runtime.js:1:2',
    '    at /private/.next/dev/server/chunks/[root-of-the-server]__0qflc76._.js:1:2',
    '    at /private/src/server/chunks/123.js:1:2',
    '    at /private/.next/server/chunks/ssr/../../secret.js:1:2',
    '    at /private/.next/server/chunks/123.js:0:2',
    '    at /private/.next/server/chunks/123.js:1:0',
    '    at /private/.next/server/chunks/123.js:1000000000:2',
  ].join('\n');
  const diagnostic = photoReadDiagnostic(context, error);
  assert.equal(diagnostic.bundleFrames, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|token|https|stack|message|file/);
});

test('TypeError, undici and TLS codes are allowlisted without exposing hosts or arbitrary code suffixes', () => {
  for (const code of ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_THIS', 'ERR_INVALID_URL', 'UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
    const cause = Object.assign(new Error('private host https://secret.invalid'), { code });
    const diagnostic = photoReadDiagnostic({ ...context, stage: 'photo-archive-upload' }, new TypeError('private token', { cause }));
    assert.equal(diagnostic.code, code);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|https|token|host|message/);
  }
  assert.equal(photoReadDiagnostic(context, Object.assign(new TypeError('private'), { code: 'ERR_INVALID_URL https://secret.invalid' })).code, undefined);
});

test('bundle frame logging calls once and rethrows the unchanged original TypeError', async () => {
  const cause = Object.assign(new Error('private URL'), { code: 'ERR_INVALID_THIS' });
  const error = new TypeError('private token', { cause });
  const stack = 'TypeError: private token\n    at privateFunction (/var/task/.next/server/chunks/[root-of-the-server]__05_4fkg._.js:1:20)';
  error.stack = stack;
  let calls = 0; const reports: PhotoReadDiagnostic[] = [];
  await assert.rejects(withPhotoReadStage({ ...context, stage: 'photo-web-read' }, () => { calls++; throw error; }, diagnostic => reports.push(diagnostic)), received => received === error);
  assert.equal(calls, 1); assert.equal(error.stack, stack); assert.equal(error.cause, cause);
  assert.equal(reports.length, 1); assert.equal(reports[0].code, 'ERR_INVALID_THIS');
  assert.deepEqual(reports[0].bundleFrames, [{ file: '[root-of-the-server]__05_4fkg._.js', line: 1, column: 20 }]);
  assert.doesNotMatch(JSON.stringify(reports), /private|token|var\/task|Function|stack|cause|message/);
});

test('the three verified hash-only Next bundle names and local production file URIs expose only basename and position', () => {
  for (const file of ['_1ujaw_3._.js', '_0fo5nfh._.js', '_0_ffime._.js']) {
    const error = new TypeError('private token');
    error.stack = `TypeError: private token\n    at secretFunction (file:///var/task/.next/server/chunks/${file}:2:100)`;
    const diagnostic = photoReadDiagnostic({ ...context, stage: 'photo-archive-upload' }, error);
    assert.deepEqual(diagnostic.bundleFrames, [{ file, line: 2, column: 100 }]);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|token|secret|file:\/|var\/task|Function|stack/);
  }
  for (const location of [
    'file://secret.invalid/var/task/.next/server/chunks/_1ujaw_3._.js',
    'file:///private/.next/server/chunks/_1ujaw_3._.js',
    'file:///var/task/.next/server/chunks/_1ujaw_3._.js?token=secret',
    'file:///var/task/.next/server/chunks/_1ujaw_3._.js#secret',
    'https://secret.invalid/.next/server/chunks/_1ujaw_3._.js',
  ]) {
    const error = new TypeError('private'); error.stack = `TypeError: private\n    at secret (${location}:1:2)`;
    assert.equal(photoReadDiagnostic(context, error).bundleFrames, undefined);
  }
});

test('message fingerprints match only four exact fixed messages without revealing any message content', () => {
  for (const [message, fingerprint] of [['fetch failed', 'fetch-failed'], ['terminated', 'terminated'], ['Invalid URL', 'invalid-url'], ['Illegal invocation', 'illegal-invocation']] as const) {
    const diagnostic = photoReadDiagnostic(context, new TypeError(message));
    assert.equal(diagnostic.messageFingerprint, fingerprint);
    assert.equal('message' in diagnostic, false); assert.equal('stack' in diagnostic, false);
  }
  for (const message of ['fetch failed token=secret', 'terminated: private secret', 'invalid URL', ' Illegal invocation', 'Illegal invocation\n']) {
    const diagnostic = photoReadDiagnostic(context, new TypeError(message));
    assert.equal(diagnostic.messageFingerprint, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|token|invocation|terminated|fetch-failed|invalid-url/);
  }
});

test('the non-callable marker reveals only a boolean and preserves the exact original error', async () => {
  const message = 'secret.token("https://private.invalid") is not a function';
  const error = new TypeError(message); const reports: PhotoReadDiagnostic[] = [];
  await assert.rejects(withPhotoReadStage({ ...context, stage: 'photo-web-upload' }, () => { throw error; }, report => reports.push(report)), received => received === error);
  assert.equal(error.message, message); assert.equal(reports[0].notAFunction, true);
  assert.doesNotMatch(JSON.stringify(reports), /private|secret|token|https|operand|is not a function/);
  for (const unrelated of ['is not a function', 'secret is not a function: private', 'private\nsecret is not a function']) {
    assert.equal(photoReadDiagnostic(context, new TypeError(unrelated)).notAFunction, undefined);
  }
});

test('nested AggregateError contributes at most three allowlisted network codes and no addresses, messages or bodies', () => {
  const child = (code: string) => Object.assign(new Error('private host https://secret.invalid token=secret'), { code, address: 'private-address', port: 443, body: { secret: 'token' } });
  const aggregate = new AggregateError([child('EAI_AGAIN'), child('ENETUNREACH'), child('EHOSTUNREACH'), child('ECONNREFUSED')], 'private connection details');
  Object.defineProperty(aggregate.errors, 3, { get: () => assert.fail('A fourth aggregate child must never be inspected.') });
  const diagnostic = photoReadDiagnostic(context, new TypeError('fetch failed', { cause: aggregate }));
  assert.equal(diagnostic.messageFingerprint, 'fetch-failed');
  assert.deepEqual(diagnostic.networkCodes, ['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|token|https|host|address|port|body|connection/);
  const unsafe = new AggregateError([child('EAI_AGAIN'), child('42501'), child('ECONNRESET https://secret.invalid'), child('EHOSTUNREACH')], 'private SQL');
  assert.deepEqual(photoReadDiagnostic(context, new TypeError('fetch failed', { cause: unsafe })).networkCodes, ['EAI_AGAIN']);
  for (const code of ['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']) assert.equal(photoReadDiagnostic(context, child(code)).code, code);
});

test('aggregate cause cycles and multiple aggregate layers keep codes bounded and leave original errors unchanged', async () => {
  const inner = new AggregateError([Object.assign(new Error('secret'), { code: 'ENETUNREACH' })], 'private inner');
  const outer = new AggregateError([
    Object.assign(new Error('private DNS'), { code: 'EAI_AGAIN' }),
    Object.assign(new Error('private host'), { code: 'EHOSTUNREACH' }),
    Object.assign(new Error('private connection'), { code: 'ECONNRESET' }),
  ], 'private outer', { cause: inner });
  inner.cause = outer;
  const error = new TypeError('terminated', { cause: outer }); const reports: PhotoReadDiagnostic[] = [];
  await assert.rejects(withPhotoReadStage(context, () => { throw error; }, report => reports.push(report)), received => received === error);
  assert.equal(error.cause, outer); assert.equal(inner.cause, outer);
  assert.deepEqual(reports[0].networkCodes, ['EAI_AGAIN', 'EHOSTUNREACH', 'ECONNRESET']);
  assert.equal(reports[0].messageFingerprint, 'terminated');
  assert.doesNotMatch(JSON.stringify(reports), /private|secret|DNS|host|connection|inner|outer|cause/);
});
