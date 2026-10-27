import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { isDatabaseUnavailable } from './database-failure';

test('connection failures wrapped by Drizzle remain unavailable without inspecting SQL or parameters', () => {
  const connection = Object.assign(new Error('Connection details withheld'), { code: 'ECONNREFUSED' });
  const wrapped = new DrizzleQueryError('select private_source from editorial_recipe', ['sensitive-input'], connection);
  assert.equal(isDatabaseUnavailable(wrapped), true);
  const postgres = new DrizzleQueryError('select 1', [], Object.assign(new Error('Server is starting'), { code: '57P03' }));
  assert.equal(isDatabaseUnavailable(postgres), true);
});

test('SQL syntax, constraint failures and application bugs are not database outages', () => {
  for (const code of ['42601', '23505', '42501', '57014']) {
    const wrapped = new DrizzleQueryError('invalid query', [], Object.assign(new Error('SQL failure'), { code }));
    assert.equal(isDatabaseUnavailable(wrapped), false);
  }
  assert.equal(isDatabaseUnavailable(new TypeError('Invalid application data')), false);
  assert.equal(isDatabaseUnavailable(new Error('Query mentions ECONNRESET in a literal')), false);
});

test('missing configuration and uncoded pg pool timeout are recognized through causes', () => {
  assert.equal(isDatabaseUnavailable(new Error('DATABASE_NOT_CONFIGURED')), true);
  assert.equal(isDatabaseUnavailable(new DrizzleQueryError('select 1', [], new Error('timeout exceeded when trying to connect'))), true);
});

test('cyclic or untrusted-shaped error objects do not loop or invoke accessors', () => {
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(isDatabaseUnavailable(cyclic), false);
  const accessor = Object.defineProperty({}, 'cause', { get() { throw new Error('must not execute'); } });
  assert.equal(isDatabaseUnavailable(accessor), false);
});
