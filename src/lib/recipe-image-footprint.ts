import type { HeroAlphaBounds } from './hero-optical-layout';

type SampledImage = {
  pixels: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
};

/** Measure the physical silhouette, so translucent glass keeps the same size as solid cookware. */
export function measureRecipeImageFootprint({ pixels, width, height, naturalWidth, naturalHeight }: SampledImage): { bounds: HeroAlphaBounds; foregroundArea: number } | null {
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 192)
    || ![naturalWidth, naturalHeight].every(value => Number.isFinite(value) && value > 0)
    || pixels.length !== width * height * 4) return null;

  let left = width, top = height, right = -1, bottom = -1, foreground = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!pixels[(y * width + x) * 4 + 3]) continue;
    foreground++;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  // Opaque editorial photographs and empty/corrupt cutouts retain their original composition.
  if (foreground < 4 || width * height - foreground < width * height * 0.02
    || left === 0 || top === 0 || right === width - 1 || bottom === height - 1
    || [0, width - 1, (height - 1) * width, width * height - 1].some(index => pixels[index * 4 + 3] !== 0)) return null;

  const pixelWidth = naturalWidth / width, pixelHeight = naturalHeight / height;
  // Sampling can round a faint edge to zero. Reserve one sample pixel around every measured edge.
  left = Math.max(0, left - 1); top = Math.max(0, top - 1);
  right = Math.min(width - 1, right + 1); bottom = Math.min(height - 1, bottom + 1);
  return {
    bounds: { x: left * pixelWidth, y: top * pixelHeight, width: (right - left + 1) * pixelWidth, height: (bottom - top + 1) * pixelHeight },
    foregroundArea: foreground * pixelWidth * pixelHeight,
  };
}
