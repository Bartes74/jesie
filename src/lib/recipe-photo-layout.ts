import type { MediaTile } from './recipe-media';

export const STEP_PHOTO_ASPECT_RATIO = 21 / 9;

/** Crop a tile around its centre while preserving the photograph's proportions. */
export function photoViewportLayout(media: MediaTile, viewportAspectRatio?: number, decorative = false) {
  const sourceRatio = media.aspectRatio ?? 1;
  const targetRatio = viewportAspectRatio ?? sourceRatio;
  // Standalone product shots already include their margins and contact shadow.
  const standalone = media.columns === 1 && media.rows === 1 && viewportAspectRatio === undefined;
  const zoom = standalone ? 1 : decorative ? 1.12 : 1.02;
  const tileWidth = Math.max(1, sourceRatio / targetRatio) * zoom;
  const tileHeight = Math.max(1, targetRatio / sourceRatio) * zoom;
  const column = media.index % media.columns;
  const row = Math.floor(media.index / media.columns);

  return {
    width: media.columns * tileWidth * 100,
    height: media.rows * tileHeight * 100,
    left: -column * tileWidth * 100 - (tileWidth - 1) * 50,
    top: -row * tileHeight * 100 - (tileHeight - 1) * 50,
  };
}
