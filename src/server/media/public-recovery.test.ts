import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { getRecipeImageVariants } from '@/lib/recipe-image-variants';
import { createPublicMediaRecovery, type PublicRecoveryAsset } from './public-recovery';

const heroId = '00000000-0000-4000-8000-000000000001';
const ingredientId = '00000000-0000-4000-8000-000000000002';
const privateId = '00000000-0000-4000-8000-000000000003';
const recipe = { id: 'public-recipe', image: `/media/${heroId}`, slug: { pl: 'publiczny-przepis', en: 'public-recipe' },
  photos: { ingredients: { flour: { src: `/media/${ingredientId}` } }, steps: {} } } as unknown as PublicRecipe;
const quota = () => Object.assign(new Error('Your account or project has exceeded the quota. Upgrade your plan to increase limits.'), { code: '53000' });
const pathname = (id: string) => `ai/${id}/web.webp`;
async function fixture(options: { registry?: Record<string, PublicRecoveryAsset>; snapshot?: () => Promise<PublicRecipe[] | null> } = {}) {
  let reads = 0, captures = 0;
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff8800' } }).webp({ lossless: true }).toBuffer();
  const recovery = createPublicMediaRecovery({
    loadSnapshot: async () => { captures++; return options.snapshot ? options.snapshot() : [recipe]; },
    loadRegistry: async () => ({ assets: options.registry ?? {
      [heroId]: { kind: 'hero', blobPathname: pathname(heroId), publicRecipeIds: [recipe.id] },
      [ingredientId]: { kind: 'ingredient', blobPathname: pathname(ingredientId), publicRecipeIds: [recipe.id] },
    } }),
    readMedia: async () => { reads++; return { bytes, contentType: 'image/webp' }; },
    readStatic: async () => { throw new Error('No static sources in this fixture'); },
  });
  return { recovery, bytes, reads: () => reads, captures: () => captures };
}

test('unrelated failures and healthy-path callers never read emergency media', async () => {
  const f = await fixture();
  for (const error of [new Error('database connection failed'), Object.assign(new Error('Other quota'), { code: '53000' }), { code: '23505' }]) {
    assert.equal(await f.recovery.asset(heroId, undefined, error), null);
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.captures(), 0);
});

test('an exact nested quota may serve only referenced ingredient bytes without changing them', async () => {
  const f = await fixture();
  const result = await f.recovery.asset(ingredientId, undefined, { cause: quota() });
  assert.equal(result?.status, 200);
  assert.deepEqual(Buffer.from(await result!.arrayBuffer()), f.bytes);
  assert.equal(result?.headers.get('Content-Type'), 'image/webp');
  assert.equal(result?.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=0, must-revalidate');
  assert.equal(f.reads(), 1);
});

test('private IDs remain inaccessible at every delivery width without reading any private file', async () => {
  const f = await fixture();
  assert.equal((await f.recovery.asset(privateId, undefined, quota()))?.status, 404);
  assert.equal((await f.recovery.asset(privateId, 160, quota()))?.status, 404);
  assert.equal(f.reads(), 0);
});

test('a snapshot-authorized ingredient has a smaller variant with the same expiry and no source changes', async () => {
  const f = await fixture();
  const result = await f.recovery.asset(ingredientId, 160, quota());
  assert.equal(result?.status, 200);
  assert.equal(result?.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=0, must-revalidate');
  const metadata = await sharp(Buffer.from(await result!.arrayBuffer())).metadata();
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 32);
  assert.equal(f.reads(), 1);
});

test('registry existence does not authorize a private asset or a mismatched photo kind', async () => {
  const f = await fixture({ registry: {
    [privateId]: { kind: 'hero', blobPathname: pathname(privateId), publicRecipeIds: [recipe.id] },
    [ingredientId]: { kind: 'hero', blobPathname: pathname(ingredientId), publicRecipeIds: [recipe.id] },
  } });
  assert.equal((await f.recovery.asset(privateId, undefined, quota()))?.status, 404);
  assert.equal((await f.recovery.asset(ingredientId, undefined, quota()))?.status, 404);
  assert.equal(f.reads(), 0);
});

test('all recorded public image shapes use the ordinary rendering service and reject forged versions', async () => {
  const f = await fixture();
  for (const variant of Object.values(getRecipeImageVariants(recipe))) {
    const parts = variant.url.split('/');
    const response = await f.recovery.variant(recipe.id, parts.at(-2)!, parts.at(-1)!, quota());
    assert.equal(response?.status, 200);
    const metadata = await sharp(Buffer.from(await response!.arrayBuffer())).metadata();
    assert.equal(metadata.width, variant.width);
    assert.equal(metadata.height, variant.height);
  }
  const reads = f.reads();
  assert.equal((await f.recovery.variant(recipe.id, 'v1-' + '0'.repeat(32), 'unknown.webp', quota()))?.status, 404);
  assert.equal((await f.recovery.variant('private-recipe', 'v1-' + '0'.repeat(32), 'unknown.webp', quota()))?.status, 404);
  assert.equal(f.reads(), reads);
});

test('public heroes keep the normal width and transparency delivery path', async () => {
  const f = await fixture();
  const response = await f.recovery.asset(heroId, 640, quota());
  assert.equal(response?.status, 200);
  const metadata = await sharp(Buffer.from(await response!.arrayBuffer())).metadata();
  // The normal service does not enlarge a source smaller than its requested width.
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 32);
});

test('an expired or unavailable public snapshot cannot authorize an image', async () => {
  const f = await fixture({ snapshot: async () => null });
  assert.equal(await f.recovery.asset(ingredientId, undefined, quota()), null);
  assert.equal(f.reads(), 0);
});

test('the snapshot clock is checked again after preparing an image', async () => {
  let calls = 0;
  const f = await fixture({ snapshot: async () => ++calls === 1 ? [recipe] : null });
  assert.equal(await f.recovery.asset(ingredientId, undefined, quota()), null);
  assert.equal(f.reads(), 1);
});

test('a corrupt source read fails closed rather than serving unrelated bytes', async () => {
  const recovery = createPublicMediaRecovery({
    loadSnapshot: async () => [recipe],
    loadRegistry: async () => ({ assets: { [ingredientId]: { kind: 'ingredient', blobPathname: pathname(ingredientId), publicRecipeIds: [recipe.id] } } }),
    readMedia: async () => { throw new Error('LOCAL_RECOVERY_FILE_INVALID'); },
  });
  await assert.rejects(recovery.asset(ingredientId, undefined, quota()), /LOCAL_RECOVERY_FILE_INVALID/);
});
