import test from 'node:test';
import assert from 'node:assert/strict';
import published from '../../../private-data/public-recovery/recipes.json';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { isNeonQuotaError, parsePublishedSnapshot, withPublishedSnapshot } from './published-snapshot';

const now = Date.parse('2026-10-13T18:30:00Z');
const quota = () => Object.assign(new Error('Your account or project has exceeded the quota. Upgrade your plan to increase limits.'), { code: '53000' });
const snapshot = () => parsePublishedSnapshot(published, now)!;

test('only the exact Pg quota code and message match, including a nested Drizzle cause', () => {
  assert.equal(isNeonQuotaError(quota()), true);
  assert.equal(isNeonQuotaError(new Error('Failed query', { cause: new Error('Wrapped', { cause: quota() }) })), true);
  for (const error of [new Error(quota().message), Object.assign(new Error('Other resource limit'), { code: '53000' }),
    Object.assign(new Error(quota().message), { code: '53300' }), new Error('Connection refused'), null]) {
    assert.equal(isNeonQuotaError(error), false);
  }
  const separateObjects = { code: '53000', cause: new Error(quota().message) };
  assert.equal(isNeonQuotaError(separateObjects), false);
});

test('cyclic and excessively deep causes are bounded', () => {
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(isNeonQuotaError(cyclic), false);
  let deep: unknown = quota();
  for (let i = 0; i < 17; i++) deep = { cause: deep };
  assert.equal(isNeonQuotaError(deep), false);
});

test('verified public capture preserves literal publication dates and excludes all seven planned drafts', () => {
  const recovered = snapshot();
  assert.equal(recovered.length, 18);
  assert.deepEqual(recovered.map(recipe => recipe.publication), published.recipes.map(recipe => recipe.publication));
  const planned = ['d3486a50-57ec-431b-81d5-939fa7372bb1', 'debd80c8-734e-4af8-a6be-b414d1906394',
    '3b128222-366b-4de7-bdfa-a3d7fef72ad3', 'c711d519-221a-42c1-b3c1-d1ce374d1826',
    '8cb0a26c-a4e5-402a-925f-584bf425ebeb', '754bfbe1-b69f-47a5-845c-5b9118b92edb', 'e1c65935-5612-459b-a5de-41cde4e9a08e'];
  for (const id of planned) assert.equal(recovered.some(recipe => recipe.id === id), false);
  for (const recipe of recovered) {
    assert.equal(Object.hasOwn(recipe, 'provenance'), false);
    assert.equal(Object.hasOwn(recipe, 'heroPresentation'), false);
    assert.equal(Object.hasOwn(recipe, 'kitchenTest'), false);
  }
});

test('snapshot expires from original capture, including when the same imported module remains cached', () => {
  assert.equal(parsePublishedSnapshot(published, Date.parse('2026-10-13T15:50:51Z')), null);
  assert.equal(parsePublishedSnapshot(published, Date.parse('2026-10-14T15:50:51Z'))?.length, 18);
  assert.equal(parsePublishedSnapshot(published, Date.parse('2026-10-14T15:50:52Z')), null);
  assert.equal(parsePublishedSnapshot(published, NaN), null);
});

test('missing, empty, altered, private and unverified content fail closed', () => {
  assert.equal(parsePublishedSnapshot(undefined, now), null);
  for (const change of [(value: typeof published) => { value.recipes = []; },
    (value: typeof published) => { value.recipes[0].id = 'e1c65935-5612-459b-a5de-41cde4e9a08e'; },
    (value: typeof published) => { value.recipes[0].description.pl += ' altered'; },
    (value: typeof published) => { value.expiresAt = '2026-10-15T15:50:52Z'; },
    (value: typeof published) => { Object.assign(value.recipes[0], { provenance: { kitchenTested: false } }); },
    (value: typeof published) => { Object.assign(value.recipes[0].ingredients[0], { privateNote: 'private' }); }]) {
    const changed = structuredClone(published);
    change(changed);
    assert.equal(parsePublishedSnapshot(changed, now), null);
  }
});

test('quota failure uses the verified snapshot for list and exact PL/EN recipe lookups', async () => {
  const fail = async () => { throw new Error('Failed query', { cause: quota() }); };
  const recovered = await withPublishedSnapshot(fail, recipes => recipes, async () => snapshot());
  assert.equal(recovered.length, 18);
  for (const locale of ['pl', 'en'] as const) {
    const slug = recovered[0].slug[locale];
    const recipe = await withPublishedSnapshot(fail, recipes => recipes.find(item => item.slug[locale] === slug) ?? null, async () => snapshot());
    assert.equal(recipe?.id, recovered[0].id);
  }
  assert.equal(await withPublishedSnapshot(fail, recipes => recipes.find(item => item.id === 'e1c65935-5612-459b-a5de-41cde4e9a08e') ?? null, async () => snapshot()), null);
});

test('successful SQL reads, including empty catalogs and withdrawn recipes, never consult the snapshot', async () => {
  let reads = 0;
  const load = async () => { reads++; return snapshot(); };
  assert.deepEqual(await withPublishedSnapshot(async () => [] as PublicRecipe[], recipes => recipes, load), []);
  assert.equal(await withPublishedSnapshot(async () => null as PublicRecipe | null, recipes => recipes[0], load), null);
  assert.equal(reads, 0);
});

test('other SQL errors rethrow, and a missing or expired snapshot preserves the original quota failure', async () => {
  const other = new Error('Connection refused');
  let reads = 0;
  await assert.rejects(withPublishedSnapshot(async () => { throw other; }, recipes => recipes, async () => { reads++; return snapshot(); }), error => error === other);
  assert.equal(reads, 0);
  for (const value of [null, []] as const) {
    const original = quota();
    await assert.rejects(withPublishedSnapshot(async () => { throw original; }, recipes => recipes, async () => value as PublicRecipe[] | null), error => error === original);
  }
});
