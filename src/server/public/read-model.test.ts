import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublicReadModel } from './read-model';
import { recipes } from '@/lib/recipes';
import { toPublicRecipe } from '@/lib/recipe-presentation';
import { collectionPublicDefinition, newCollectionContent } from '@/lib/collections';
const recipe = () => toPublicRecipe({ ...structuredClone(recipes[0]), publication: { datePublished: '2026-10-18T04:00:00Z', dateModified: '2026-10-18T04:00:00Z', author: 'jesie.pl' }, version: '3' });
function fixture() {
  let now = Date.parse('2026-10-18T12:00:00Z'), sequence = 0;
  const files = new Map<string, { bytes: Buffer; etag: string }>();
  const apply = async (path: string, bytes: Buffer, condition?: { ifMatch?: string; createOnly?: boolean }) => {
    if (condition?.createOnly && files.has(path) || condition?.ifMatch && files.get(path)?.etag !== condition.ifMatch) throw new Error('CAS_CONFLICT');
    files.set(path, { bytes: Buffer.from(bytes), etag: String(++sequence) });
  };
  const io = { now: () => now, read: async (path: string) => files.get(path) ?? null, write: apply };
  return { files, io, apply, clock: (value: number) => { now = value; }, model: createPublicReadModel(io) };
}
test('v2 fallback contains published collection definitions while v1 means collection data is unknown', async () => {
  const f = fixture();
  await f.model.refresh([recipe()]);
  assert.equal((await f.model.readContent())?.collections, null);
  const definition = collectionPublicDefinition('event-fixture', { ...newCollectionContent('Wieczór'),
    title: { pl: 'Wieczór', en: 'Evening' }, description: { pl: 'Opis', en: 'Description' }, slug: { pl: 'wieczor', en: 'evening' }, recipeIds: [recipe().id] });
  await f.model.refresh([recipe()], [definition]);
  assert.deepEqual((await f.model.readContent())?.collections, [definition]);
  assert.equal((await f.model.read())?.length, 1);
  await f.model.invalidate();
  assert.equal(await f.model.readContent(), null);
  await f.model.refresh([recipe()], []);
  assert.deepEqual((await f.model.readContent())?.collections, []);
});
test('collection fallback rejects private design inputs before persisting a public snapshot', async () => {
  const f = fixture();
  const definition = collectionPublicDefinition('event-fixture', newCollectionContent('Wieczór'));
  await assert.rejects(f.model.refresh([], [{ ...definition, appearanceBrief: 'Private editorial inspiration' } as typeof definition]));
  assert.equal(f.files.size, 0);
});
test('renewable snapshots preserve only public data and expire exactly 24h after capture', async () => {
  const f = fixture(); const head = await f.model.refresh([recipe()]);
  assert.deepEqual(await f.model.read(), JSON.parse(JSON.stringify([recipe()])));
  if (head.state !== 'ready') assert.fail();
  f.clock(head.expiresAt - 1); assert.equal((await f.model.read())?.length, 1);
  f.clock(head.expiresAt); assert.equal(await f.model.read(), null);
  await f.model.refresh([recipe()]); assert.equal((await f.model.read())?.length, 1);
});
test('withdrawal fences both earlier downloads and persistent copies; empty catalogue is authoritative', async () => {
  const f = fixture(); await f.model.refresh([recipe()]);
  await f.model.invalidate(); assert.equal(await f.model.read(), null);
  await f.model.refresh([]); assert.deepEqual(await f.model.read(), []);
  assert.equal(f.files.size, 2);
});
test('unconfirmed delayed ready-head write cannot overwrite a newer withdrawal', async () => {
  const f = fixture(); await f.model.refresh([recipe()]);
  let late: (() => Promise<void>) | undefined;
  const uncertain = createPublicReadModel({ ...f.io, write: async (path, bytes, condition) => {
    if (path === 'head.json') { late = () => f.apply(path, bytes, condition); throw new Error('UNCONFIRMED'); }
    return f.apply(path, bytes, condition);
  } });
  await assert.rejects(uncertain.refresh([recipe()]), /UNCONFIRMED/);
  await f.model.invalidate();
  await assert.rejects(late!(), /CAS_CONFLICT/);
  assert.equal(await f.model.read(), null);
});
test('a withdrawal while the body is read wins against the captured head', async () => {
  const f = fixture(); await f.model.refresh([recipe()]);
  const racing = createPublicReadModel({ ...f.io, read: async path => {
    const value = f.files.get(path) ?? null;
    if (path.startsWith('snapshot')) await f.model.invalidate();
    return value;
  } });
  assert.equal(await racing.read(), null);
});
test('corrupt bytes, private fields and duplicate identities never become fallback content', async () => {
  const f = fixture(); const head = await f.model.refresh([recipe()]); if (head.state !== 'ready') assert.fail();
  const path = `snapshot-${head.slot}.json`;
  for (const payload of [{ version: 1, recipes: [recipe(), recipe()] }, { version: 1, recipes: [{ ...recipe(), kitchenTest: { notes: 'private' } }] }]) {
    const bytes = Buffer.from(JSON.stringify(payload));
    f.files.set(path, { bytes, etag: 'body' });
    f.files.set('head.json', { bytes: Buffer.from(JSON.stringify({ ...head, sha256: createHash('sha256').update(bytes).digest('hex') })), etag: 'head' });
    assert.equal(await f.model.read(), null);
  }
});

test('external references cannot be written or restored from an older valid fallback', async () => {
  const f = fixture(); const head = await f.model.refresh([recipe()]); if (head.state !== 'ready') assert.fail();
  const contaminated = recipe(); contaminated.storage.en = 'Cool quickly. ([food.gov.uk](https://food.gov.uk/guide))';
  await assert.rejects(f.model.refresh([contaminated]), /RECIPE_EXTERNAL_REFERENCE/);
  const bytes = Buffer.from(JSON.stringify({ version: 1, recipes: [contaminated] }));
  f.files.set(`snapshot-${head.slot}.json`, { bytes, etag: 'body' });
  f.files.set('head.json', { bytes: Buffer.from(JSON.stringify({ ...head, sha256: createHash('sha256').update(bytes).digest('hex') })), etag: 'head' });
  assert.equal(await f.model.read(), null);
});
