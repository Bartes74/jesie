import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaTile } from './recipe-media';
import { photoViewportLayout, STEP_PHOTO_ASPECT_RATIO } from './recipe-photo-layout';

const tile: MediaTile = {
  src: '/media/step', columns: 1, rows: 1, index: 0,
  alt: { pl: 'Detal przygotowania', en: 'Cooking detail' }, aspectRatio: 1.5,
};
function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
}

test('a 21:9 step viewport crops a 3:2 photograph without distorting it', () => {
  const original = structuredClone(tile);
  const layout = photoViewportLayout(tile, STEP_PHOTO_ASPECT_RATIO);
  close(layout.width, 102);
  close(layout.height, 102 * STEP_PHOTO_ASPECT_RATIO / 1.5);
  close(layout.left + layout.width / 2, 50);
  close(layout.top + layout.height / 2, 50);
  close(layout.width / layout.height * STEP_PHOTO_ASPECT_RATIO, 1.5);
  assert.deepEqual(tile, original);
});

test('every legacy atlas tile stays centred and fills the viewport without adjacent tiles', () => {
  for (const sourceRatio of [1.5, 2.25]) {
    for (let index = 0; index < 6; index++) {
      const media = { ...tile, columns: 2, rows: 3, index, aspectRatio: sourceRatio };
      const layout = photoViewportLayout(media, STEP_PHOTO_ASPECT_RATIO);
      const tileWidth = layout.width / media.columns;
      const tileHeight = layout.height / media.rows;
      const tileLeft = layout.left + index % media.columns * tileWidth;
      const tileTop = layout.top + Math.floor(index / media.columns) * tileHeight;
      assert.ok(tileLeft <= 0 && tileLeft + tileWidth >= 100);
      assert.ok(tileTop <= 0 && tileTop + tileHeight >= 100);
      close(tileLeft + tileWidth / 2, 50);
      close(tileTop + tileHeight / 2, 50);
      close(layout.width / layout.height * STEP_PHOTO_ASPECT_RATIO, media.columns / media.rows * sourceRatio);
    }
  }
});

test('native 21:9 step photographs retain their full composition apart from the existing edge inset', () => {
  const layout = photoViewportLayout({ ...tile, aspectRatio: STEP_PHOTO_ASPECT_RATIO }, STEP_PHOTO_ASPECT_RATIO);
  close(layout.width, 102);
  close(layout.height, 102);
  close(layout.left, -1);
  close(layout.top, -1);
});

test('ingredient atlas presentation retains its existing dimensions and inset', () => {
  const layout = photoViewportLayout({ ...tile, columns: 4, rows: 3, index: 5, aspectRatio: undefined }, undefined, true);
  close(layout.width, 448);
  close(layout.height, 336);
  close(layout.left, -118);
  close(layout.top, -118);
});

test('standalone ingredient photographs show their whole frame, including natural shadow and margins', () => {
  const media = { ...tile, aspectRatio: 1 };
  for (const decorative of [false, true]) {
    const layout = photoViewportLayout(media, undefined, decorative);
    close(layout.width, 100);
    close(layout.height, 100);
    close(layout.left, 0);
    close(layout.top, 0);
  }
});
