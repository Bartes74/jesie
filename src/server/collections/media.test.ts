import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { collectionAssetPath, collectionAssetPattern, normalizeCollectionImage } from './media';

test('collection media preserves the entire artwork and strips uploaded metadata', async () => {
  const source = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#d3b99d' } }).withMetadata({ exif: { IFD0: { Artist: 'Private inspiration owner' } } }).png().toBuffer();
  const result = await normalizeCollectionImage(source, true);
  assert.equal(result.width, 200); assert.equal(result.height, 100);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined);
});
test('collection media accepts only bounded rasters and immutable UUID paths', async () => {
  const id = '7d6d72e0-09f4-46b9-913a-939714550b99';
  assert.equal(collectionAssetPattern.test(id), true);
  assert.equal(collectionAssetPattern.test('../private'), false);
  assert.equal(collectionAssetPath(id), `media/collections/${id}.webp`);
  await assert.rejects(normalizeCollectionImage(Buffer.alloc(10 * 1024 * 1024 + 1), true), /rozmiar/);
  await assert.rejects(normalizeCollectionImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), true), /JPEG/);
});
