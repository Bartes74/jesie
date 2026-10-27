import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as imageActions from './image-actions';
import { AiError } from './errors';

const originalId = '2ea1ce57-50f5-47f7-90a6-23609bbea875';
const childId = '59f1f0da-625f-41c6-b032-4dda2578e5c1';
const original = { id: originalId, recipeId: 'recipe', kind: 'hero', provider: 'fal', model: imageActions.approvedImageModel,
  status: 'failed', providerRequestId: 'request', providerFinishedAt: new Date(), errorCode: 'AI_TRANSPARENCY_MISSING', result: null, appliedRevision: null };

function previewHarness(options: { child?: boolean; otherRecipe?: boolean; errorCode?: string; missing?: boolean; contentType?: string; size?: number; completed?: boolean } = {}) {
  const calls: string[] = [];
  let cancelled = false;
  const source = { ...original, ...(options.errorCode ? { errorCode: options.errorCode } : {}), ...(options.otherRecipe ? { recipeId: 'other-recipe' } : {}),
    ...(options.completed ? { status: 'ready', errorCode: null, result: { asset: { id: 'completed-asset' } } } : {}) };
  const child = { ...source, id: childId, recipeId: 'recipe', model: imageActions.heroCutoutModel, errorCode: 'AI_MASK_NOT_FOUND', input: { recipe: { image: imageActions.failedHeroSourcePrefix + originalId } } };
  const imports: Record<string, unknown> = {
    'server-only': {}, './store': {}, './errors': { AiError }, './image-actions': imageActions, '@/server/media/storage': {},
  };
  const exports: Partial<typeof import('./retained-photo-preview')> = {};
  const code = ts.transpileModule(readFileSync(new URL('./retained-photo-preview.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Buffer, require: (name: string) => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; } });
  return { calls, cancelled: () => cancelled, run: (id = options.child ? childId : originalId) => exports.readRetainedPhotoPreview!(id, {
    job: async jobId => { calls.push(`job:${jobId}`); return (jobId === childId ? child : source) as Parameters<typeof imageActions.isRecoverableHeroSource>[0] & { id: string }; },
    blob: async pathname => {
      calls.push(`blob:${pathname}`);
      if (options.missing) return null;
      return { statusCode: 200, blob: { size: options.size ?? 3, contentType: options.contentType ?? 'image/webp' },
        stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, pull(controller) { controller.close(); }, cancel() { cancelled = true; } }) };
    },
  }) };
}

test('retained preview reads only the exact archived photograph and supports failed mask lineage', async () => {
  const direct = previewHarness();
  const photo = await direct.run();
  assert.deepEqual(photo.bytes, Buffer.from([1, 2, 3]));
  assert.equal(photo.contentType, 'image/webp');
  assert.deepEqual(direct.calls, [`job:${originalId}`, `blob:ai/${originalId}/recovered-original.webp`]);
  const child = previewHarness({ child: true });
  await child.run();
  assert.deepEqual(child.calls, [`job:${childId}`, `job:${originalId}`, `blob:ai/${originalId}/recovered-original.webp`]);
});

test('retained preview rejects path injection, unrelated failures and another recipe before reading files', async () => {
  const traversal = previewHarness();
  await assert.rejects(traversal.run('../private'), (error: unknown) => error instanceof AiError && error.status === 404);
  assert.deepEqual(traversal.calls, []);
  const failed = previewHarness({ errorCode: 'AI_PROVIDER_REJECTED' });
  await assert.rejects(failed.run());
  assert.deepEqual(failed.calls, [`job:${originalId}`]);
  const unrelated = previewHarness({ child: true, otherRecipe: true });
  await assert.rejects(unrelated.run());
  assert.deepEqual(unrelated.calls, [`job:${childId}`, `job:${originalId}`]);
});

test('missing archives do not contact the provider and malformed archive responses are rejected', async () => {
  const missing = previewHarness({ missing: true });
  await assert.rejects(missing.run());
  assert.deepEqual(missing.calls, [`job:${originalId}`, `blob:ai/${originalId}/recovered-original.webp`, `blob:ai/${originalId}/recovered-original.png`]);
  const invalidType = previewHarness({ contentType: 'text/html' });
  await assert.rejects(invalidType.run());
  assert.equal(invalidType.cancelled(), true);
  const oversized = previewHarness({ size: 33 * 1024 * 1024 });
  await assert.rejects(oversized.run());
  assert.equal(oversized.cancelled(), true);
});

test('recovered ready sources use their normal result instead of reopening the failed-original endpoint', async () => {
  for (const child of [false, true]) {
    const completed = previewHarness({ completed: true, child });
    await assert.rejects(completed.run(), (error: unknown) => error instanceof AiError && error.status === 404);
    assert.deepEqual(completed.calls, child ? [`job:${childId}`, `job:${originalId}`] : [`job:${originalId}`]);
  }
});

function routeHarness(deny = false) {
  const calls: string[] = [];
  const imports: Record<string, unknown> = {
    '@/server/ai/retained-photo-preview': { readRetainedPhotoPreview: async (id: string) => { calls.push(`photo:${id}`); return { bytes: Buffer.from([1, 2, 3]), contentType: 'image/webp' }; } },
    '@/server/http/admin': { adminActor: async () => { calls.push('auth'); if (deny) throw new AiError(401, 'UNAUTHENTICATED', 'Denied'); } },
    '@/server/http/ai': { aiFailure: (error: AiError) => new Response(null, { status: error.status }) },
    '@/server/auth': { AdminAccessError: class extends Error { constructor(message: string, public status: number) { super(message); } } },
  };
  const exports: Partial<typeof import('../../app/api/admin/ai/[id]/photo/route')> = {};
  const code = ts.transpileModule(readFileSync(new URL('../../app/api/admin/ai/[id]/photo/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Buffer, Uint8Array, Response, URL, require: (name: string) => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; } });
  return { calls, run: (headers: HeadersInit = {}) => exports.GET!(new Request(`https://example.test/api/admin/ai/${originalId}/photo`, { headers }), { params: Promise.resolve({ id: originalId }) }) };
}

test('photo route authenticates before archive access and blocks cross-origin embedding', async () => {
  const denied = routeHarness(true);
  assert.equal((await denied.run()).status, 401);
  assert.deepEqual(denied.calls, ['auth']);
  const crossOriginHeaders: HeadersInit[] = [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://other.test' }];
  for (const headers of crossOriginHeaders) {
    const crossSite = routeHarness();
    assert.equal((await crossSite.run(headers)).status, 403);
    assert.deepEqual(crossSite.calls, ['auth']);
  }
});

test('photo route returns authenticated native image bytes with private non-cacheable headers', async () => {
  const route = routeHarness();
  const response = await route.run({ 'sec-fetch-site': 'same-origin' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
  assert.deepEqual(route.calls, ['auth', `photo:${originalId}`]);
});
