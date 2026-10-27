import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchiveCatalog, isKnownDerivativePath, loadArchiveReferenceSnapshot, referenceScopes, type ArchiveBlob, type ArchiveReferenceSnapshot } from './reference-graph';

const id = '12345678-abcd-abcd-abcd-123456789012';
const job = '12345678-abcd-abcd-abcd-123456789013';
const capturedAt = '2026-10-17T00:00:00.000Z';
const blob = (pathname: string): ArchiveBlob => ({ pathname, size: 123, etag: '"immutable"', uploadedAt: capturedAt });
const snapshot = (overrides: Partial<ArchiveReferenceSnapshot> = {}): ArchiveReferenceSnapshot => ({ capturedAt,
  coverage: Object.fromEntries(referenceScopes.map(scope => [scope, true])) as ArchiveReferenceSnapshot['coverage'],
  assets: [], jobs: [], documents: [], compactions: [], ...overrides });

test('collection artwork and private inspirations stay retained through their own reference scopes', () => {
  const pathname = `media/collections/${id}.webp`;
  const result = buildArchiveCatalog('primary123', [blob(pathname)], snapshot({
    assets: [{ id, jobId: job, recipeId: '', kind: 'inspiration', blobPathname: pathname, originalBlobPathname: null }],
    documents: [{ scope: 'collection_generations', id: 'generation', content: { inspirationAssetId: id } },
      { scope: 'collection_publications', id: 'publication', content: { theme: { hero: { assetId: id, src: `/media/collections/${id}` } } } }],
  }));
  assert.equal(result.complete, true);
  assert.ok(result.objects[0].roles.includes('final_master'));
  assert.ok(result.objects[0].references.includes('collection_publications:publication'));
  assert.deepEqual(result.referencedPathsAbsentFromInventory, []);
});

test('history, Trash, ingredient reuse and masks retain final masters and editing archives through compact redirects', () => {
  const original = `ai/${job}/original.png`, final = `ai/${job}/web-v1.webp`, compact = `ai/compact/v1/${'a'.repeat(64)}.webp`;
  const result = buildArchiveCatalog('primary123', [blob(final), blob(compact)], snapshot({
    assets: [{ id, jobId: job, recipeId: 'recipe', kind: 'hero', blobPathname: final, originalBlobPathname: original }],
    documents: [
      { scope: 'recipes', id: 'trashed-recipe', content: { deletedAt: capturedAt, image: `/media/${id}` } },
      { scope: 'versions', id: 'recipe:1', content: { image: `/media/${id}` } },
      { scope: 'publications', id: 'old-publication', content: { image: `/media/${id}` } },
      { scope: 'ingredient_library', id: 'library', content: { assetId: id, sourceJobId: job } },
      { scope: 'photo_batches', id: 'batch', content: { recoverySourceJobId: job } },
      { scope: 'recovery_registry', id: 'mask', content: { sourceAssetId: id } },
    ], compactions: [{ sourcePathname: original, targetPathname: compact }],
  }));
  assert.equal(result.complete, true);
  const archive = result.objects.find(row => row.pathname === compact)!;
  assert.ok(archive.roles.includes('editing_archive')); assert.ok(archive.roles.includes('compacted_source'));
  for (const ref of ['recipes:trashed-recipe', 'versions:recipe:1', 'publications:old-publication', 'ingredient_library:library', 'recovery_registry:mask']) assert.ok(archive.references.includes(ref), ref);
  assert.ok(result.objects.find(row => row.pathname === final)!.roles.includes('final_master'));
  assert.deepEqual(result.referencedPathsAbsentFromInventory, []);
});

test('failed hero recovery sources and uncertain mask outputs remain protected without registered assets', () => {
  const source = `ai/${job}/recovered-original.webp`, mask = `ai/${job}/masks/v1.png`;
  const result = buildArchiveCatalog('primary123', [blob(source), blob(mask)], snapshot({ jobs: [{ id: job, status: 'uncertain', input: {}, result: null }] }));
  assert.ok(result.objects.find(row => row.pathname === source)!.roles.includes('recovery_source'));
  assert.ok(result.objects.find(row => row.pathname === mask)!.roles.includes('mask'));
  for (const object of result.objects) assert.ok(object.references.includes(`job:${job}:uncertain`));
});

test('literal, escaped and frontend derivative URLs in future fields are references, without exposing contents', () => {
  const pathname = `seo/delivery/${id}/v1.webp`;
  const result = buildArchiveCatalog('primary123', [blob(pathname)], snapshot({ documents: [
    { scope: 'versions', id: 'literal', content: { newField: `private prompt https://example.invalid/${pathname}?secret=not-persisted` } },
    { scope: 'trends', id: 'escaped', content: { html: encodeURIComponent(pathname) } },
    { scope: 'recipes', id: 'frontend', content: { url: '/media/' + pathname.slice(4) } },
  ] }));
  assert.deepEqual(result.objects[0].references, ['recipes:frontend', 'trends:escaped', 'versions:literal']);
  assert.ok(!JSON.stringify(result).includes('secret='));
});

test('unknown paths stay unknown, exact variant version is allowlisted and reference hashes ignore inventory order', () => {
  const variant = `media-variants/webp-delivery-v1/${'a'.repeat(64)}/step/${'b'.repeat(64)}.webp`;
  assert.equal(isKnownDerivativePath(variant), true);
  assert.equal(isKnownDerivativePath(variant.replace('v1/', 'v2/')), false);
  const objects = [blob('uploads/unknown.webp'), blob(variant)];
  const result = buildArchiveCatalog('primary123', objects, snapshot());
  assert.equal(result.referenceGraphSha256, buildArchiveCatalog('primary123', [...objects].reverse(), snapshot()).referenceGraphSha256);
  assert.deepEqual(result.objects.find(row => row.pathname.startsWith('uploads/'))!.roles, ['unknown']);
});

test('partial coverage is incomplete; absent retained sources remain explicit for independent alias closure', () => {
  const partial = snapshot(); partial.coverage.versions = false;
  assert.equal(buildArchiveCatalog('primary123', [], partial).complete, false);
  const missing = buildArchiveCatalog('primary123', [], snapshot({ assets: [{ id, jobId: job, recipeId: 'recipe', kind: 'hero', blobPathname: `ai/${job}/web-v1.webp`, originalBlobPathname: null }] }));
  assert.equal(missing.complete, true); assert.equal(missing.referencedPathsAbsentFromInventory.length, 1);
});

test('loader requires read-only consistent transaction and reads unfiltered history, Trash and optional variant index', async () => {
  const statements: string[] = [];
  const load = async (indexPresent: boolean) => loadArchiveReferenceSnapshot(async statement => {
    statements.push(statement);
    if (statement.includes('current_setting')) return { rows: [{ read_only: 'on', isolation: 'repeatable read' }] };
    if (statement.includes('to_regclass')) return { rows: [{ variant_table: indexPresent ? 'media_delivery_variant' : null }] };
    if (statement.includes('FROM media_delivery_variant')) return { rows: [{ id: 'variant', content: { sourcePathname: `ai/${job}/web-v1.webp`, blobPathname: `media-variants/webp-delivery-v1/${'a'.repeat(64)}/hero/${'b'.repeat(64)}.webp`, status: 'rendering' } }] };
    return { rows: [] };
  }, []);
  const absent = await load(false); assert.equal(absent.coverage.variant_index, true);
  const present = await load(true); assert.equal(present.documents.find(row => row.scope === 'variant_index')?.id, 'variant');
  assert.ok(statements.includes('SELECT id, content FROM editorial_recipe'));
  assert.ok(!statements.some(statement => /\b(?:DELETE|UPDATE|INSERT)\b/.test(statement)));
  await assert.rejects(loadArchiveReferenceSnapshot(async () => ({ rows: [{ read_only: 'off', isolation: 'read committed' }] })), /ARCHIVE_READ_ONLY_SNAPSHOT_REQUIRED/);
});

test('a variant index protects both master and every nonnull derivative receipt while it is rendering', () => {
  const master = `ai/${job}/web-v1.webp`, variant = `media-variants/webp-delivery-v1/${'a'.repeat(64)}/hero/${'b'.repeat(64)}.webp`;
  const result = buildArchiveCatalog('primary123', [blob(master), blob(variant)], snapshot({ documents: [{ scope: 'variant_index', id: 'key', content: { sourcePathname: master, blobPathname: variant, status: 'rendering' } }] }));
  for (const object of result.objects) assert.ok(object.references.includes('variant_index:key'));
  assert.deepEqual(result.objects.find(row => row.pathname === variant)!.roles, ['derivative']);
});

test('real content-addressed variants in encoded URLs and embedded text retain exact literal references', () => {
  const pathname = `media-variants/webp-delivery-v1/${'c'.repeat(64)}/ingredient/${'d'.repeat(64)}.webp`;
  const seo = `seo/delivery/${id}/v1.webp`;
  const values = [
    pathname, `https://private.example.invalid/${pathname}?signature=not-saved`,
    encodeURIComponent(pathname), `prefix${pathname}suffix`,
    `html <img src="/media/delivery/${id}/v1.webp?x=1">`,
    `malformed%ZZ ${pathname}`, `${pathname}${seo}`,
  ];
  const documents = values.map((content, index) => ({ scope: 'versions' as const, id: String(index), content }));
  const catalog = buildArchiveCatalog('primary123', [blob(pathname), blob(seo)], snapshot({ documents }));
  for (const object of catalog.objects) {
    const frontend = object.pathname.replace(/^seo\//, '/media/');
    const expected = values.flatMap((value, index) => {
      let decoded = value; try { decoded = decodeURIComponent(value); } catch { /* same literal fallback */ }
      return decoded.includes(object.pathname) || decoded.includes(frontend) ? [`versions:${index}`] : [];
    });
    assert.deepEqual(object.references, expected);
  }
});

test('large derivative and document collections retain only exact matches without cross-product reference work', () => {
  const count = 2000;
  const objects = Array.from({ length: count }, (_, index) => blob(`media-variants/webp-delivery-v1/${'a'.repeat(64)}/step/${index.toString(16).padStart(64, '0')}.webp`));
  const documents = objects.map((object, index) => ({ scope: 'versions' as const, id: String(index), content: { note: `ready https://private.example.invalid/${encodeURIComponent(object.pathname)}?private=true`, other: 'A recipe without media references.' } }));
  const catalog = buildArchiveCatalog('primary123', objects, snapshot({ documents }));
  assert.equal(catalog.objects.length, count);
  for (let index = 0; index < count; index++) assert.deepEqual(catalog.objects[index].references, [`versions:${index}`]);
  assert.ok(!JSON.stringify(catalog).includes('?private=true'));
});
