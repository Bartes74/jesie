import 'server-only';
import sharp from 'sharp';
import type { FormattedPhoto } from './photo-format';

const maximumPixels = 8_500_000;
const maximumBytes = 32 * 1024 * 1024;

/**
 * Canonicalize only the alpha endpoints used by solid generated heroes.
 * Callers exclude glass and custom compositions and validate the resulting cutout.
 * RGB, intermediate alpha, source geometry, openings and shadows remain unchanged.
 * A narrowly gated transparent canvas margin may surround the retained frame.
 */
export async function normalizeGeneratedHeroAlpha(bytes: Buffer): Promise<(FormattedPhoto & { changedPixels: number; padded: boolean }) | null> {
  if (!bytes.length || bytes.length > maximumBytes) return null;
  try {
    const decoder = sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' });
    const metadata = await decoder.metadata();
    if (!metadata.width || !metadata.height || !metadata.hasAlpha || metadata.channels !== 4 || metadata.space !== 'srgb'
      || metadata.depth !== 'uchar' || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1
      || !['png', 'webp'].includes(metadata.format ?? '')) return null;
    const { data, info } = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return null;
    let changedPixels = 0;
    for (let offset = 3; offset < data.length; offset += 4) {
      const alpha = data[offset];
      if (alpha > 0 && alpha <= 8) { data[offset] = 0; changedPixels++; }
      else if (alpha >= 250 && alpha < 255) { data[offset] = 255; changedPixels++; }
    }
    const { width, height } = info;
    const corners = [0, width - 1, (height - 1) * width, width * height - 1];
    let transparent = 0, opaque = 0, clearBoundary = 0, boundary = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const alpha = data[pixel * 4 + 3];
      if (alpha === 0) transparent++;
      if (alpha === 255) opaque++;
      const x = pixel % width, y = Math.floor(pixel / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) { boundary++; if (alpha === 0) clearBoundary++; }
    }
    // A handle can reach one corner of a genuinely isolated photograph. Add
    // empty canvas, never infer an edge or erase source pixels. The existing
    // clear exterior and perimeter gates exclude opaque/background photographs;
    // the caller must still validate that the food centre is retained.
    const padding = corners.filter(pixel => data[pixel * 4 + 3] !== 0).length === 1
      && transparent >= width * height * 0.1 && opaque >= width * height * 0.1
      && clearBoundary >= boundary * 0.9 ? Math.max(1, Math.ceil(Math.max(width, height) * 0.01)) : 0;
    const paddedWidth = width + padding * 2, paddedHeight = height + padding * 2;
    if (paddedWidth * paddedHeight > maximumPixels || paddedWidth > 3840 || paddedHeight > 3840) return null;
    let pixels = data;
    if (padding) {
      pixels = Buffer.alloc(paddedWidth * paddedHeight * 4);
      for (let row = 0; row < height; row++) data.copy(pixels, ((row + padding) * paddedWidth + padding) * 4, row * width * 4, (row + 1) * width * 4);
    }
    const normalized = await sharp(pixels, { raw: { width: paddedWidth, height: paddedHeight, channels: 4 } }).png().toBuffer();
    return { bytes: normalized, width: paddedWidth, height: paddedHeight, changedPixels, padded: padding > 0 };
  } catch {
    return null;
  }
}
