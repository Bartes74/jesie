import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createStaticMediaDelivery, isPublicStaticImage, readPublicStaticImage, renderStaticMediaWidth } from './static-delivery';

function storage(readSource: (src: string) => Promise<Buffer> = readPublicStaticImage) {
  const saved = new Map<string, Buffer>();
  const dependencies = {
    readSource,
    readBlob: async (pathname: string, maximum: number) => {
      const bytes = saved.get(pathname); if (bytes && bytes.length > maximum) throw new Error('Oversized Blob'); return bytes ?? null;
    },
    putBlob: async (pathname: string, bytes: Buffer) => {
      if (saved.has(pathname)) throw new Error('Already exists'); saved.set(pathname, bytes);
    },
  };
  return { saved, dependencies };
}

test('real public hero, ingredient atlas and step atlas survive a fresh process cache without another render', async () => {
  const mock = storage(); let renders = 0;
  const first = createStaticMediaDelivery(mock.dependencies);
  const second = createStaticMediaDelivery(mock.dependencies);
  for (const src of ['/images/lemon-pasta.webp', '/images/ingredients-1.webp', '/images/steps-lemon-pasta.webp']) {
    const expected = await first.variant(src, 'responsive:160', bytes => { renders++; return renderStaticMediaWidth(bytes, 160); });
    const actual = await second.variant(src, 'responsive:160', async () => { throw new Error('A durable hit cannot render'); });
    assert.deepEqual(actual, expected);
    assert.equal(actual.width, 160);
    assert.equal((await sharp(actual.bytes).metadata()).format, 'webp');
  }
  assert.equal(renders, 3); assert.equal(mock.saved.size, 6);
  assert([...mock.saved.keys()].every(key => key.startsWith('media-variants/static-webp-delivery-v1/')));
});

test('source bytes and declared target bind receipts while unsupported targets fail before storage', async () => {
  let source = await sharp({ create: { width: 96, height: 48, channels: 4, background: '#123456ff' } }).png().toBuffer();
  const mock = storage(async () => source), media = createStaticMediaDelivery(mock.dependencies);
  const first = await media.responsive('/images/test.png', 160);
  assert.equal(first.width, 96, 'A small static source is never enlarged');
  source = await sharp({ create: { width: 96, height: 48, channels: 4, background: '#ee4400ff' } }).png().toBuffer();
  const second = await media.responsive('/images/test.png', 160);
  assert(!first.bytes.equals(second.bytes)); assert.equal(mock.saved.size, 4);
  await assert.rejects(media.variant('/images/test.png', 'recipe:1x1', async () => first), /Invalid static delivery/);
  for (const src of ['/images/../private.png', '/images/%2e%2e/private.png', '/images/a.png?x=1', 'https://example.test/a.png', '/private/a.png']) {
    assert.equal(isPublicStaticImage(src), false);
    await assert.rejects(media.responsive(src, 160), /Invalid static delivery/);
  }
});

test('public source access rejects traversal and escaping symlinks before reading private files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jesie-static-delivery-'));
  try {
    const images = path.join(directory, 'images'); await mkdir(images);
    const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#ee4400' } }).png().toBuffer();
    await writeFile(path.join(images, 'safe.png'), bytes);
    await writeFile(path.join(directory, 'private.png'), bytes);
    await symlink(path.join(directory, 'private.png'), path.join(images, 'escape.png'));
    assert.deepEqual(await readPublicStaticImage('/images/safe.png', images), bytes);
    await assert.rejects(readPublicStaticImage('/images/escape.png', images), /leaves its directory/);
    await assert.rejects(readPublicStaticImage('/images/../private.png', images), /Invalid public image path/);
    await assert.rejects(readPublicStaticImage('/images/%2e%2e/private.png', images), /Invalid public image path/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt receipts and pixels cannot become cache hits or overwrite immutable files; outage still serves source rendering', async () => {
  const mock = storage(); let renders = 0;
  const render = async (bytes: Buffer) => { renders++; return renderStaticMediaWidth(bytes, 160); };
  const media = createStaticMediaDelivery(mock.dependencies);
  const original = await media.variant('/images/lemon-pasta.webp', 'responsive:160', render);
  const receipt = [...mock.saved.keys()].find(key => key.endsWith('.json'))!;
  const pixels = [...mock.saved.keys()].find(key => key.endsWith('.webp'))!;
  const goodReceipt = mock.saved.get(receipt)!;
  const foreign = JSON.parse(goodReceipt.toString()); foreign.sourceSha256 = '0'.repeat(64);
  mock.saved.set(receipt, Buffer.from(JSON.stringify(foreign)));
  assert.deepEqual(await media.variant('/images/lemon-pasta.webp', 'responsive:160', render), original);
  assert.deepEqual(mock.saved.get(receipt), Buffer.from(JSON.stringify(foreign)), 'No corrupt file is overwritten');
  mock.saved.set(receipt, goodReceipt); mock.saved.set(pixels, Buffer.from('corrupt'));
  assert.deepEqual(await media.variant('/images/lemon-pasta.webp', 'responsive:160', render), original);
  assert.equal(renders, 3);
  const unavailable = createStaticMediaDelivery({ ...mock.dependencies,
    readBlob: async () => { throw new Error('Storage unavailable'); }, putBlob: async () => { throw new Error('Storage unavailable'); } });
  assert.deepEqual(await unavailable.variant('/images/lemon-pasta.webp', 'responsive:160', render), original);
});

test('singleflight and uncertain conditional uploads leave one verified receipt reusable by another instance', async () => {
  const mock = storage(); let renders = 0;
  const media = createStaticMediaDelivery({ ...mock.dependencies, putBlob: async (pathname, bytes) => {
    await mock.dependencies.putBlob(pathname, bytes); throw new Error('The accepted upload response was lost');
  } });
  const render = async (bytes: Buffer) => { renders++; return renderStaticMediaWidth(bytes, 160); };
  const results = await Promise.all(Array.from({ length: 4 }, () => media.variant('/images/steps-lemon-pasta.webp', 'responsive:160', render)));
  assert.equal(renders, 1); assert.equal(mock.saved.size, 2);
  assert(results.every(result => result.bytes.equals(results[0].bytes)));
  assert.deepEqual(await createStaticMediaDelivery(mock.dependencies).variant('/images/steps-lemon-pasta.webp', 'responsive:160', async () => {
    throw new Error('A readback-proven immutable receipt needs no rendering');
  }), results[0]);
});
