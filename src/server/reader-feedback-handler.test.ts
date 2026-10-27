import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReaderFeedback, sameFeedbackSubmission } from './reader-feedback';

const payload = { requestKey: 'f4f97189-f8be-4777-942e-8cd5d42a0405', recipeId: 'lemon-pasta', version: '7', kind: 'problem', stepId: 'old-step', message: 'Sauce split.' };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://jesie.pl/api/feedback', { method: 'POST', headers: { origin: 'https://jesie.pl', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('a deduplication key confirms only the same recipe, publication and message', () => {
  const stored = { recipe_id: payload.recipeId, publication_revision: 7, kind: payload.kind, step_id: payload.stepId, message: payload.message };
  const input = { ...payload, kind: 'problem' as const };
  assert.equal(sameFeedbackSubmission(stored, input), true);
  for (const change of [{ recipeId: 'other' }, { version: '8' }, { kind: 'success' as const }, { stepId: 'other-step' }, { message: 'Changed text' }]) assert.equal(sameFeedbackSubmission(stored, { ...input, ...change }), false);
});

test('feedback binds a problem to the submitted publication, even when a newer page has different steps', async () => {
  let submitted = false;
  const result = await handleReaderFeedback(request(payload), {
    published: async (id, version) => { assert.equal(id, payload.recipeId); assert.equal(version, '7'); return { version: '7', steps: [{ id: 'old-step' }] }; },
    submit: async input => { submitted = true; assert.equal(input.version, '7'); assert.equal(input.stepId, 'old-step'); return true; },
  });
  assert.equal(result.status, 202);
  assert.equal(submitted, true);
});
test('rejects a step absent from the selected immutable publication', async () => {
  const result = await handleReaderFeedback(request(payload), { published: async () => ({ version: '7', steps: [{ id: 'different' }] }), submit: async () => { assert.fail('Invalid step must never be submitted'); } });
  assert.equal(result.status, 404);
});
test('private notes, session IDs and arbitrary extra dimensions cannot enter a feedback record', async () => {
  for (const extra of [{ sessionId: 'private-session' }, { note: 'My private recipe note' }, { email: 'someone@example.com' }]) {
    const result = await handleReaderFeedback(request({ ...payload, ...extra }), { published: async () => { assert.fail('Private dimensions must be rejected before reading a recipe'); } });
    assert.equal(result.status, 400);
  }
});
test('bounds real streamed bytes even when Content-Length is absent or dishonest', async () => {
  let readRecipe = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(8193))); controller.close(); } });
  const oversized = new Request('https://jesie.pl/api/feedback', { method: 'POST', headers: { origin: 'https://jesie.pl', 'content-type': 'application/json', 'content-length': '5' }, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const result = await handleReaderFeedback(oversized, { published: async () => { readRecipe = true; return null; } });
  assert.equal(result.status, 413);
  assert.equal(readRecipe, false);
});
test('accepts a full 1500-character Unicode message and rejects oversized messages and invalid revisions', async () => {
  const dependencies = { published: async () => ({ version: '7', steps: [{ id: 'old-step' }] }), submit: async () => true };
  assert.equal((await handleReaderFeedback(request({ ...payload, message: 'ą'.repeat(1500) }), dependencies)).status, 202);
  assert.equal((await handleReaderFeedback(request({ ...payload, message: 'ą'.repeat(1501) }), dependencies)).status, 400);
  for (const version of ['0', '2147483648', '999999999999']) assert.equal((await handleReaderFeedback(request({ ...payload, version }), dependencies)).status, 400);
});
test('rejects cross-origin posts and malformed UTF-8 without submitting', async () => {
  assert.equal((await handleReaderFeedback(request(payload, { origin: 'https://other.example' }))).status, 403);
  const malformed = new Request('https://jesie.pl/api/feedback', { method: 'POST', headers: { origin: 'https://jesie.pl', 'content-type': 'application/json' }, body: Uint8Array.of(0xc3, 0x28) });
  assert.equal((await handleReaderFeedback(malformed)).status, 400);
});
