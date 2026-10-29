import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { BlobError } from '@vercel/blob';
import { recipes } from '@/lib/recipes';
import { getRecipeImageVariants, type RecipeImageSource } from '@/lib/recipe-image-variants';
import { createRecipeMediaService, isStaticRecipeImage, parsePublicHeroWidth, publicHeroWidths, publishedHeroPath, readBoundedMedia, renderRecipeImageVariant, writeRecipeMediaOnce, type RecipeMediaDependencies } from './media';
import { normalizeHeroPresentation } from '@/server/ai/hero-presentation';
import type { DeliveryPhoto } from '@/server/media/delivery';
import { createStaticMediaDelivery } from '@/server/media/static-delivery';

const baseRecipe = recipes[0];
const assetId = '12345678-abcd-abcd-abcd-123456789012';
const source = () => sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#b44928' } }).png().toBuffer();
const stream = (bytes: Buffer) => new Response(new Uint8Array(bytes)).body!;

function fixture(bytes: Buffer) {
  let published: RecipeImageSource | null = baseRecipe;
  let reads = 0;
  const saved = new Map<string, Buffer>();
  const dependencies: RecipeMediaDependencies = {
    publishedRecipe: async id => published?.id === id ? published : null,
    asset: async () => ({ id: assetId, recipeId: baseRecipe.id, kind: 'hero', blobPathname: 'source.webp' }),
    assetPublic: async id => published?.image === `/media/${id}`,
    readStored: async pathname => { const value = saved.get(pathname); return value ? { stream: stream(value), size: value.length } : null; },
    writeStored: async (pathname, value) => { saved.set(pathname, value); },
    readStatic: async () => { reads++; return bytes; },
  };
  return { dependencies, saved, reads: () => reads, setPublished: (value: RecipeImageSource | null) => { published = value; } };
}

test('only an active publication can read a named derivative; withdrawn or stale URLs never read sources', async () => {
  const mock = fixture(await source());
  const service = createRecipeMediaService(mock.dependencies);
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).classic.url.split('/');
  mock.setPublished(null);
  assert.equal(await service.recipeImage(id, version, filename), null);
  mock.setPublished(baseRecipe);
  assert.equal(await service.recipeImage(id, 'v1-' + '0'.repeat(32), filename), null);
  assert.equal(await service.recipeImage(id, version, 'invented-1600x1200.webp'), null);
  assert.equal(mock.reads(), 0);
  await assert.rejects(service.prepareRecipeMedia({ ...baseRecipe, image: '/images/stale.webp' }), /current published/);
});

test('durable registered SEO and full-hero hits avoid master reads and remain publication guarded', async () => {
  const bytes = await source(); const mock = fixture(bytes);
  const recipe = { ...baseRecipe, image: `/media/${assetId}` }; mock.setPublished(recipe);
  mock.dependencies.persistDerivatives = false;
  mock.dependencies.asset = async () => ({ id: assetId, recipeId: recipe.id, kind: 'hero', blobPathname: 'ai/test/master.webp' });
  mock.dependencies.readStored = async () => { throw new Error('A durable hit cannot read the editing master'); };
  let withdraw = false, reads = 0;
  const classic = getRecipeImageVariants(recipe).classic;
  const image: DeliveryPhoto = { bytes: await renderRecipeImageVariant(bytes, classic), width: classic.width, height: classic.height };
  mock.dependencies.variants = { read: async () => { reads++; if (withdraw) mock.setPublished(null); return image; },
    write: async () => { throw new Error('A durable hit cannot write'); } };
  const service = createRecipeMediaService(mock.dependencies);
  const [, , , id, version, filename] = classic.url.split('/');
  const named = await service.recipeImage(id, version, filename); assert(named);
  assert.deepEqual(Buffer.from(await new Response(named.stream).arrayBuffer()), image.bytes);
  const hero = await service.publicHeroDelivery({ id: assetId, recipeId: recipe.id, kind: 'hero', blobPathname: 'ai/test/master.webp' }); assert(hero);
  await hero.stream.cancel();
  withdraw = true; assert.equal(await service.recipeImage(id, version, filename), null);
  const before = reads; assert.equal(await service.recipeImage(id, version, filename), null); assert.equal(reads, before);
  mock.setPublished(recipe);
  assert.equal(await service.publicHeroDelivery({ id: assetId, recipeId: recipe.id, kind: 'hero', blobPathname: 'ai/test/master.webp' }), null);
});

test('an unavailable durable index falls back to the exact existing SEO renderer without changing publication', async () => {
  const bytes = await source(); const mock = fixture(bytes);
  const recipe = { ...baseRecipe, image: `/media/${assetId}` }; mock.setPublished(recipe);
  mock.dependencies.persistDerivatives = false;
  mock.dependencies.asset = async () => ({ id: assetId, recipeId: recipe.id, kind: 'hero', blobPathname: 'ai/test/master.webp' });
  mock.saved.set('ai/test/master.webp', bytes);
  mock.dependencies.variants = { read: async () => { throw new Error('Index unavailable'); }, write: async () => false };
  const target = getRecipeImageVariants(recipe).social;
  const [, , , id, version, filename] = target.url.split('/');
  const image = await createRecipeMediaService(mock.dependencies).recipeImage(id, version, filename); assert(image);
  assert.deepEqual(Buffer.from(await new Response(image.stream).arrayBuffer()), await renderRecipeImageVariant(bytes, target));
  assert.equal(mock.saved.size, 1); assert.equal(mock.reads(), 0);
});

test('all five legacy SEO targets persist once across fresh services and publication withdrawal still fails closed', async () => {
  const bytes = await source(), mock = fixture(bytes), saved = new Map<string, Buffer>();
  let renders = 0, reads = 0, withdraw = false;
  const storage = {
    readSource: async () => bytes,
    readBlob: async (pathname: string) => { reads++; if (withdraw) mock.setPublished(null); return saved.get(pathname) ?? null; },
    putBlob: async (pathname: string, value: Buffer) => { if (saved.has(pathname)) throw new Error('Immutable duplicate'); saved.set(pathname, value); },
  };
  function service() {
    const cache = createStaticMediaDelivery(storage);
    return createRecipeMediaService({ ...mock.dependencies, persistDerivatives: false,
      staticVariant: (src, target) => cache.variant(src, `recipe:${target.width}x${target.height}`, async source => {
        renders++; return { bytes: await renderRecipeImageVariant(source, target), width: target.width, height: target.height };
      }),
    });
  }
  for (const target of Object.values(getRecipeImageVariants(baseRecipe))) {
    const [, , , id, version, filename] = target.url.split('/');
    const first = await service().recipeImage(id, version, filename); assert(first);
    const expected = Buffer.from(await new Response(first.stream).arrayBuffer());
    const second = await service().recipeImage(id, version, filename); assert(second);
    assert.deepEqual(Buffer.from(await new Response(second.stream).arrayBuffer()), expected);
    const info = await sharp(expected).metadata(); assert.equal(info.width, target.width); assert.equal(info.height, target.height);
  }
  assert.equal(renders, 5); assert.equal(saved.size, 10);
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  mock.setPublished(null); const before = reads;
  assert.equal(await service().recipeImage(id, version, filename), null); assert.equal(reads, before);
  mock.setPublished(baseRecipe); withdraw = true;
  assert.equal(await service().recipeImage(id, version, filename), null);
  assert.equal(renders, 5, 'Withdrawal on a durable read never triggers another rendering');
});

test('publish preparation is resumable and prepares the three search derivatives once while sharing crops are paused', async () => {
  const mock = fixture(await source());
  const service = createRecipeMediaService(mock.dependencies);
  await service.prepareRecipeMedia(baseRecipe);
  assert.equal(mock.reads(), 1);
  assert.equal(mock.saved.size, 3);
  for (const [name, variant] of Object.entries(getRecipeImageVariants(baseRecipe))) {
    const image = mock.saved.get('seo/' + variant.url.replace(/^\/media\//, ''))!;
    if (name === 'social' || name === 'pinterest') { assert.equal(image, undefined); continue; }
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, variant.width);
    assert.equal(metadata.height, variant.height);
    assert.equal(metadata.hasAlpha, false);
    assert.ok(image.length < 4 * 1024 * 1024);
  }
  await service.prepareRecipeMedia(baseRecipe);
  assert.equal(mock.reads(), 1);
  assert.equal(mock.saved.size, 3);
});

test('concurrent publication events reuse a winning immutable upload after generic Blob duplicate errors', async () => {
  const mock = fixture(await source());
  let releaseFirst: (() => void) | undefined;
  let firstVariantArrivals = 0;
  let collisions = 0;
  mock.dependencies.writeStored = (pathname, bytes) => writeRecipeMediaOnce(pathname, bytes, {
    put: async (target, data) => {
      if (target.endsWith('-1600x1200.webp')) {
        firstVariantArrivals++;
        if (firstVariantArrivals === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
        else releaseFirst!();
      }
      if (mock.saved.has(target)) { collisions++; throw new BlobError('This blob already exists, use allowOverwrite: true if you want to overwrite it.'); }
      mock.saved.set(target, data);
    },
    readFresh: async target => {
      const value = mock.saved.get(target);
      return value ? { stream: stream(value), size: value.length, contentType: 'image/webp' } : null;
    },
  });
  const service = createRecipeMediaService(mock.dependencies);
  await Promise.all([service.prepareRecipeMedia(baseRecipe), service.prepareRecipeMedia(baseRecipe)]);
  assert.ok(collisions >= 1);
  assert.equal(mock.saved.size, 3);
});

test('immutable upload recovery preserves the original error unless a bounded WebP exists at the exact path', async () => {
  const original = new BlobError('The upload failed');
  const pathname = 'seo/recipes/current/v1/photo.webp';
  const put = async () => { throw original; };
  let confirmedPath = '';
  await writeRecipeMediaOnce(pathname, Buffer.from('new image'), {
    put, readFresh: async target => { confirmedPath = target; return { stream: stream(Buffer.from('existing image')), size: 14, contentType: 'image/webp' }; },
  });
  assert.equal(confirmedPath, pathname);
  for (const existing of [null, { size: 0, contentType: 'image/webp' }, { size: 4 * 1024 * 1024 + 1, contentType: 'image/webp' }, { size: 14, contentType: 'text/html' }]) {
    await assert.rejects(writeRecipeMediaOnce(pathname, Buffer.from('new image'), {
      put, readFresh: async () => existing ? { ...existing, stream: stream(Buffer.from('existing image')) } : null,
    }), error => error === original);
  }
  await assert.rejects(writeRecipeMediaOnce(pathname, Buffer.from('new image'), {
    put, readFresh: async () => { throw new Error('Read permission failed'); },
  }), error => error === original);
});

test('legacy first access prepares one variant, then reuses it, without writing a recipe snapshot', async () => {
  const mock = fixture(await source());
  const service = createRecipeMediaService(mock.dependencies);
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  const image = await service.recipeImage(id, version, filename);
  assert.ok(image);
  await image.stream.cancel();
  assert.equal(mock.reads(), 1);
  assert.equal(mock.saved.size, 1);
  await (await service.recipeImage(id, version, filename))!.stream.cancel();
  assert.equal(mock.reads(), 1);
  mock.setPublished(null);
  assert.equal(await service.recipeImage(id, version, filename), null);
});

test('a withdrawal during first-time preparation prevents a public response', async () => {
  const mock = fixture(await source());
  mock.dependencies.writeStored = async () => { mock.setPublished(null); };
  const service = createRecipeMediaService(mock.dependencies);
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  assert.equal(await service.recipeImage(id, version, filename), null);
});

test('withdrawal or image replacement during a cached Blob read cancels the stream before a public response', async () => {
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  for (const changed of [null, { ...baseRecipe, image: '/images/replacement.webp' }]) {
    const mock = fixture(Buffer.from('unused'));
    let cancelled = false;
    mock.dependencies.readStored = async () => {
      mock.setPublished(changed);
      return { stream: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
    };
    assert.equal(await createRecipeMediaService(mock.dependencies).recipeImage(id, version, filename), null);
    assert.equal(cancelled, true);
    assert.equal(mock.reads(), 0);
  }
});

test('published source references must resolve to the exact registered hero asset', async () => {
  const mock = fixture(await source());
  const recipe = { ...baseRecipe, image: `/media/${assetId}` };
  mock.setPublished(recipe);
  mock.dependencies.asset = async () => ({ id: 'another-asset', recipeId: 'other-recipe', kind: 'hero', blobPathname: 'private.webp' });
  await assert.rejects(createRecipeMediaService(mock.dependencies).prepareRecipeMedia(recipe), /authorized finished dish/);
  mock.dependencies.asset = async () => ({ id: assetId, recipeId: recipe.id, kind: 'ingredient', blobPathname: 'private.webp' });
  await assert.rejects(createRecipeMediaService(mock.dependencies).prepareRecipeMedia(recipe), /authorized finished dish/);
});

test('a published duplicate can reuse its source recipe hero while unrelated private references stay inaccessible', async () => {
  const bytes = await source();
  const mock = fixture(bytes);
  const duplicate = { ...baseRecipe, id: 'published-copy', image: `/media/${assetId}`, slug: { pl: 'cytrynowy-makaron-kopia', en: 'lemon-pasta-copy' } };
  mock.setPublished(duplicate);
  mock.saved.set('source.webp', bytes);
  const service = createRecipeMediaService(mock.dependencies);
  await service.prepareRecipeMedia(duplicate);
  assert.equal(mock.saved.size, 5, 'The duplicate prepares three recipe derivatives and the shared UI hero.');
  const [, , , id, version, filename] = getRecipeImageVariants(duplicate).classic.url.split('/');
  const image = await service.recipeImage(id, version, filename);
  assert.ok(image);
  await image.stream.cancel();
  const hero = await service.publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640);
  assert.ok(hero, 'The published duplicate authorizes the producer recipe’s hero without consulting its ownership.');
  await hero.stream.cancel();

  const unrelatedPrivate = { ...duplicate, image: '/media/87654321-abcd-abcd-abcd-123456789012' };
  const [, , , privateId, privateVersion, privateFilename] = getRecipeImageVariants(unrelatedPrivate).classic.url.split('/');
  assert.equal(await service.recipeImage(privateId, privateVersion, privateFilename), null);
  await assert.rejects(service.prepareRecipeMedia(unrelatedPrivate), /current published/);
  mock.setPublished(null);
  assert.equal(await service.recipeImage(id, version, filename), null);
  assert.equal(await service.publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640), null);
});

test('static sources reject traversal, remote URLs, atlases and unsupported formats', () => {
  assert.equal(isStaticRecipeImage('/images/lemon-pasta.webp'), true);
  for (const url of ['https://attacker.test/x.webp', '/images/../private.webp', '/images/%2e%2e/private.webp', '/images/steps-lemon-pasta.webp', '/images/ingredients-1.webp', '/images/x.svg', '/images/x.webp?url=remote']) assert.equal(isStaticRecipeImage(url), false, url);
});

test('an SVG disguised as a raster photograph is rejected before sharp reads it', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.test/private"/></svg>');
  await assert.rejects(renderRecipeImageVariant(svg, { width: 1600, height: 900 }), /Invalid raster/);
});

test('private hero prewarming preserves presentation and reuses the stored delivery on retries', async () => {
  const bytes = await source();
  const mock = fixture(bytes);
  const recipe = { ...baseRecipe, image: `/media/${assetId}` };
  mock.setPublished(recipe);
  mock.saved.set('source.webp', bytes);
  const service = createRecipeMediaService(mock.dependencies);
  await service.prepareRecipeMedia(recipe);
  assert.equal(mock.saved.size, 5, 'Three variants, one original and one UI delivery.');
  const display = await service.heroDelivery((await mock.dependencies.asset(assetId))!);
  const metadata = await sharp(await readBoundedMedia(display)).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1800);
  assert.equal(metadata.height, 1200);
  await service.prepareRecipeMedia(recipe);
  assert.equal(mock.saved.size, 5);
});

test('published hero delivery retains the normalized cutout silhouette and visible RGBA pixels', async () => {
  const width = 240, height = 100;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = x >= 137 && x < 211 && y >= 9 && y < 72 ? 255 : x === 136 && y === 40 ? 1 : 0;
    rgba.set([x % 256, y % 256, (x * 3 + y * 7) % 256, alpha], (y * width + x) * 4);
  }
  const original = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const normalized = await normalizeHeroPresentation(original);
  assert.ok(normalized);
  const mock = fixture(original);
  mock.saved.set('source.webp', original);
  const display = await createRecipeMediaService(mock.dependencies).heroDelivery((await mock.dependencies.asset(assetId))!);
  const bytes = await readBoundedMedia(display);
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const expected = await sharp(normalized.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(decoded.length, expected.length);
  for (let offset = 0; offset < decoded.length; offset += 4) {
    assert.equal(decoded[offset + 3], expected[offset + 3]);
    if (expected[offset + 3] > 0) assert.deepEqual(decoded.subarray(offset, offset + 4), expected.subarray(offset, offset + 4));
  }
});

test('responsive hero query accepts only one exact allowed width', () => {
  assert.equal(parsePublicHeroWidth(new URLSearchParams()), undefined);
  for (const width of publicHeroWidths) assert.equal(parsePublicHeroWidth(new URLSearchParams(`w=${width}`)), width);
  for (const query of ['w=', 'w=0', 'w=-640', 'w=1.28e3', 'w=0320', 'w=400', 'w=999999999', 'w=640&w=640']) {
    assert.equal(parsePublicHeroWidth(new URLSearchParams(query)), null, query);
  }
});

test('public hero widths resize the canvas proportionally without storing screen-size duplicates', async () => {
  const mock = fixture(await source());
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  mock.saved.set('source.webp', await source());
  const service = createRecipeMediaService(mock.dependencies);
  const asset = (await mock.dependencies.asset(assetId))!;
  for (const width of publicHeroWidths) {
    const image = await service.publicHeroDelivery(asset, width);
    assert.ok(image);
    const metadata = await sharp(await readBoundedMedia(image)).metadata();
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, Math.round(width * 1200 / 1800));
    assert.equal(metadata.format, 'webp');
    assert.equal(mock.saved.has(publishedHeroPath(assetId, width)), false);
  }
  assert.equal(mock.saved.size, 2, 'Only the original and normalized master are stored; responsive responses use the CDN.');
  await (await service.publicHeroDelivery(asset, 640))!.stream.cancel();
  assert.equal(mock.saved.size, 2);
});

test('responsive cutout hero keeps its centred frame and transparent corners without clipping the vessel', async () => {
  const bytes = await sharp({ create: { width: 1000, height: 1000, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 850, height: 700, channels: 4, background: '#be301aff' } }).png().toBuffer(), left: 75, top: 150 }]).png().toBuffer();
  const mock = fixture(bytes);
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  mock.saved.set('source.webp', bytes);
  const image = await createRecipeMediaService(mock.dependencies).publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640);
  assert.ok(image);
  const output = await readBoundedMedia(image);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 640);
  assert.equal(metadata.height, 640);
  assert.equal(metadata.hasAlpha, true);
  const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
  for (const [x, y] of [[0, 0], [639, 0], [0, 639], [639, 639]]) assert.equal(pixels[(y * 640 + x) * 4 + 3], 0);
  assert.equal(pixels[(320 * 640 + 320) * 4 + 3], 255);
});

test('responsive hero never reads or writes a draft, unrelated asset or non-hero image', async () => {
  const mock = fixture(Buffer.from('unused'));
  let reads = 0, writes = 0;
  mock.dependencies.readStored = async () => { reads++; throw new Error('A draft must not read storage'); };
  mock.dependencies.writeStored = async () => { writes++; throw new Error('A draft must not write storage'); };
  const service = createRecipeMediaService(mock.dependencies);
  const asset = (await mock.dependencies.asset(assetId))!;
  assert.equal(await service.publicHeroDelivery(asset, 640), null);
  mock.setPublished({ ...baseRecipe, image: '/media/87654321-abcd-abcd-abcd-123456789012' });
  assert.equal(await service.publicHeroDelivery(asset, 640), null);
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  assert.equal(await service.publicHeroDelivery({ ...asset, kind: 'ingredient' }, 640), null);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('responsive cached hero cancels its stream when withdrawn or replaced during the Blob read', async () => {
  for (const changed of [null, { ...baseRecipe, image: '/media/87654321-abcd-abcd-abcd-123456789012' }]) {
    const mock = fixture(Buffer.from('unused'));
    mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
    let cancelled = false;
    mock.dependencies.readStored = async pathname => {
      assert.equal(pathname, publishedHeroPath(assetId, 640));
      mock.setPublished(changed);
      return { stream: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
    };
    assert.equal(await createRecipeMediaService(mock.dependencies).publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640), null);
    assert.equal(cancelled, true);
  }
});

test('responsive hero created during withdrawal remains private and cannot produce a public response', async () => {
  const mock = fixture(await source());
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  mock.saved.set('source.webp', await source());
  mock.dependencies.writeStored = async (pathname, bytes) => {
    mock.saved.set(pathname, bytes);
    if (pathname === publishedHeroPath(assetId)) mock.setPublished(null);
  };
  const service = createRecipeMediaService(mock.dependencies);
  const asset = (await mock.dependencies.asset(assetId))!;
  assert.equal(await service.publicHeroDelivery(asset, 640), null);
  assert.equal(await service.publicHeroDelivery(asset, 640), null);
});

test('concurrent responsive requests reuse the winning master without storing resized copies', async () => {
  const mock = fixture(await source());
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  mock.saved.set('source.webp', await source());
  let releaseFirst: (() => void) | undefined;
  let masterArrivals = 0, collisions = 0;
  mock.dependencies.writeStored = (pathname, bytes) => writeRecipeMediaOnce(pathname, bytes, {
    put: async (target, data) => {
      if (target === publishedHeroPath(assetId)) {
        masterArrivals++;
        if (masterArrivals === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
        else releaseFirst!();
      }
      if (mock.saved.has(target)) { collisions++; throw new BlobError('This blob already exists'); }
      mock.saved.set(target, data);
    },
    readFresh: async target => {
      const bytes = mock.saved.get(target);
      return bytes ? { stream: stream(bytes), size: bytes.length, contentType: 'image/webp' } : null;
    },
  });
  const service = createRecipeMediaService(mock.dependencies);
  const asset = (await mock.dependencies.asset(assetId))!;
  const images = await Promise.all([service.publicHeroDelivery(asset, 640), service.publicHeroDelivery(asset, 640)]);
  for (const image of images) { assert.ok(image); await image.stream.cancel(); }
  assert.ok(collisions >= 1);
  assert.equal(mock.saved.size, 2);
});

test('a full Hobby store keeps newly requested public derivatives available without changing publication data', async () => {
  const bytes = await source();
  const mock = fixture(bytes);
  let writes = 0;
  mock.dependencies.writeStored = async () => { writes++; throw new BlobError('Storage quota exceeded for Hobby plan (1GB maximum)'); };
  const service = createRecipeMediaService(mock.dependencies);
  await service.prepareRecipeMedia(baseRecipe);
  assert.equal(writes, 1, 'Prewarming stops at the first rejected optional cache write.');
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  const image = await service.recipeImage(id, version, filename);
  assert.ok(image);
  const metadata = await sharp(await readBoundedMedia(image)).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 630);
  assert.equal(metadata.format, 'webp');
  assert.equal(mock.saved.size, 0);
  mock.setPublished(null);
  assert.equal(await service.recipeImage(id, version, filename), null);
});

test('CDN-only delivery never persists social or responsive derivatives in the source store', async () => {
  const bytes = await source();
  const mock = fixture(bytes);
  mock.dependencies.persistDerivatives = false;
  mock.dependencies.writeStored = async () => { assert.fail('CDN-only derivatives cannot refill Blob storage'); };
  const service = createRecipeMediaService(mock.dependencies);
  await service.prepareRecipeMedia(baseRecipe);
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  const image = await service.recipeImage(id, version, filename);
  assert.ok(image); await image.stream.cancel();
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  mock.saved.set('source.webp', bytes);
  const hero = await service.publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640);
  assert.ok(hero); await hero.stream.cancel();
  assert.equal(mock.saved.size, 1);
  mock.setPublished(null);
  assert.equal(await service.publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640), null);
});

test('CDN-only static recipe derivatives do not touch a Blob store that rejects reads with 403', async () => {
  const mock = fixture(await source());
  let storageReads = 0;
  mock.dependencies.persistDerivatives = false;
  mock.dependencies.readStored = async () => {
    storageReads++;
    throw new BlobError('Failed to retrieve blob: 403 Forbidden');
  };
  mock.dependencies.writeStored = async () => { assert.fail('Static CDN delivery must not write Blob cache'); };
  const service = createRecipeMediaService(mock.dependencies);
  await service.prepareRecipeMedia(baseRecipe);
  for (const variant of Object.values(getRecipeImageVariants(baseRecipe))) {
    const [, , , id, version, filename] = variant.url.split('/');
    const image = await service.recipeImage(id, version, filename);
    assert.ok(image);
    const metadata = await sharp(await readBoundedMedia(image)).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, variant.width);
    assert.equal(metadata.height, variant.height);
  }
  assert.equal(storageReads, 0);
  assert.equal(mock.reads(), 6, 'Prewarming and five deliveries read only the bundled static source.');
});

test('CDN-only static delivery still denies stale, withdrawn or replaced publication images', async () => {
  const mock = fixture(await source());
  mock.dependencies.persistDerivatives = false;
  mock.dependencies.readStored = async () => { assert.fail('Publication checks cannot touch optional Blob cache'); };
  mock.dependencies.writeStored = async () => { assert.fail('CDN-only delivery cannot write optional Blob cache'); };
  const service = createRecipeMediaService(mock.dependencies);
  const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
  mock.setPublished(null);
  assert.equal(await service.recipeImage(id, version, filename), null);
  mock.setPublished(baseRecipe);
  assert.equal(await service.recipeImage(id, 'v1-' + '0'.repeat(32), filename), null);
  assert.equal(mock.reads(), 0);
  const bytes = await source();
  for (const replacement of [null, { ...baseRecipe, image: '/images/replaced.webp' }]) {
    mock.setPublished(baseRecipe);
    mock.dependencies.readStatic = async () => { mock.setPublished(replacement); return bytes; };
    assert.equal(await service.recipeImage(id, version, filename), null);
  }
});

test('CDN-only hero delivery skips seo cache reads but preserves failures of the registered AI source', async () => {
  const mock = fixture(await source());
  mock.dependencies.persistDerivatives = false;
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  const asset = { id: assetId, recipeId: baseRecipe.id, kind: 'hero', blobPathname: `ai/${assetId}/web.webp` };
  mock.dependencies.asset = async () => asset;
  const failure = new BlobError('Failed to retrieve blob: 403 Forbidden');
  const accessed: string[] = [];
  mock.dependencies.readStored = async pathname => { accessed.push(pathname); throw failure; };
  mock.dependencies.writeStored = async () => { assert.fail('CDN-only delivery cannot write optional Blob cache'); };
  const service = createRecipeMediaService(mock.dependencies);
  await assert.rejects(service.publicHeroDelivery(asset, 640), error => error === failure);
  const [, , , id, version, filename] = getRecipeImageVariants({ ...baseRecipe, image: `/media/${assetId}` }).social.url.split('/');
  await assert.rejects(service.recipeImage(id, version, filename), error => error === failure);
  assert.deepEqual(accessed, [asset.blobPathname, asset.blobPathname]);
});

test('a public responsive hero renders from its existing source when the optional master cache is full', async () => {
  const bytes = await source();
  const mock = fixture(bytes);
  mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
  mock.saved.set('source.webp', bytes);
  mock.dependencies.writeStored = async () => { throw new BlobError('Storage quota exceeded for Hobby plan (1GB maximum)'); };
  const service = createRecipeMediaService(mock.dependencies);
  const asset = (await mock.dependencies.asset(assetId))!;
  const image = await service.publicHeroDelivery(asset, 640);
  assert.ok(image);
  const metadata = await sharp(await readBoundedMedia(image)).metadata();
  assert.equal(metadata.width, 640);
  assert.equal(metadata.format, 'webp');
  assert.equal(mock.saved.size, 1);
  mock.setPublished(null);
  assert.equal(await service.publicHeroDelivery(asset, 640), null);
});

test('a withdrawal during a rejected optional cache write still prevents a public image response', async () => {
  for (const accessor of ['recipe', 'hero'] as const) {
    const bytes = await source();
    const mock = fixture(bytes);
    mock.dependencies.writeStored = async () => {
      mock.setPublished(null);
      throw new BlobError('Storage quota exceeded for Hobby plan (1GB maximum)');
    };
    const service = createRecipeMediaService(mock.dependencies);
    if (accessor === 'recipe') {
      const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
      assert.equal(await service.recipeImage(id, version, filename), null);
    } else {
      mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
      mock.saved.set('source.webp', bytes);
      assert.equal(await service.publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640), null);
    }
  }
});

test('optional cache rendering does not hide authentication, service or unrelated failures', async () => {
  for (const error of [new BlobError('Access denied'), new BlobError('The store has been suspended'), new Error('Storage quota exceeded'), new Error('Connection reset')]) {
    const bytes = await source();
    const mock = fixture(bytes);
    mock.dependencies.writeStored = async () => { throw error; };
    const service = createRecipeMediaService(mock.dependencies);
    await assert.rejects(service.prepareRecipeMedia(baseRecipe), caught => caught === error);
    const [, , , id, version, filename] = getRecipeImageVariants(baseRecipe).social.url.split('/');
    await assert.rejects(service.recipeImage(id, version, filename), caught => caught === error);
    mock.setPublished({ ...baseRecipe, image: `/media/${assetId}` });
    mock.saved.set('source.webp', bytes);
    await assert.rejects(service.publicHeroDelivery((await mock.dependencies.asset(assetId))!, 640), caught => caught === error);
  }
});

test('cutout derivatives contain the complete subject in wide and vertical crops', async () => {
  const transparent = await sharp({ create: { width: 500, height: 500, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 440, height: 440, channels: 4, background: '#be301aff' } }).png().toBuffer(), left: 30, top: 30 }]).png().toBuffer();
  for (const size of [{ width: 1200, height: 630 }, { width: 1000, height: 1500 }]) {
    const bytes = await renderRecipeImageVariant(transparent, size);
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    const center = pixel(Math.floor(size.width / 2), Math.floor(size.height / 2));
    assert.ok(center[0] > center[1] * 2);
    for (const [x, y] of [[0, 0], [size.width - 1, 0], [0, size.height - 1], [size.width - 1, size.height - 1]]) {
      const corner = pixel(x, y);
      assert.ok(corner[0] >= 240 && corner[1] >= 240 && corner[2] >= 230, 'Every corner remains clear paper: the subject has not been clipped.');
    }
  }
});

test('oversized source streams stop reading and cancel rather than building an unbounded buffer', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(12)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedMedia({ stream: oversized }, 10), /size limit/);
  assert.equal(cancelled, true);
});
