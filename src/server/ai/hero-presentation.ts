import 'server-only';
import sharp from 'sharp';
import { PhotoFormatError, validateCutout, type CutoutValidation, type FormattedPhoto } from './photo-format';

const maximumPixels = 8_500_000;
const maximumBytes = 32 * 1024 * 1024;
const subjectOccupancy = 0.92;

/** Raw delivery canvas avoids encoding a full-size PNG before making a thumbnail. */
export async function normalizeHeroPresentationRaster(sourceBytes: Buffer): Promise<{ pixels: Buffer; width: number; height: number } | null> {
  if (!sourceBytes.length || sourceBytes.length > maximumBytes) return null;
  const metadata = await sharp(sourceBytes, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height || !metadata.hasAlpha || metadata.depth !== 'uchar'
    || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1
    || !['png', 'webp'].includes(metadata.format ?? '')
    || metadata.width * metadata.height > maximumPixels) return null;

  let cutout: CutoutValidation;
  try { cutout = await validateCutout(sourceBytes); }
  catch (error) {
    if (error instanceof PhotoFormatError && error.code === 'PHOTO_CUTOUT_INVALID') return null;
    throw error;
  }

  // Bounds include even alpha=1 antialiasing. Removing only empty exterior cannot clip the rim.
  const { bounds } = cutout;
  const side = Math.ceil(Math.max(bounds.width, bounds.height) / subjectOccupancy);
  if (!Number.isSafeInteger(side) || side < 1 || side * side > maximumPixels) return null;
  const left = Math.floor((side - bounds.width) / 2);
  const top = Math.floor((side - bounds.height) / 2);
  const { data, info } = await sharp(sourceBytes, { limitInputPixels: maximumPixels, failOn: 'error' })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== cutout.width || info.height !== cutout.height || info.channels !== 4) return null;

  // Copy rather than resize/composite, so soft-edge RGB and alpha are never premultiplied.
  const output = Buffer.alloc(side * side * 4);
  for (let row = 0; row < bounds.height; row++) {
    const start = ((bounds.top + row) * info.width + bounds.left) * 4;
    data.copy(output, ((top + row) * side + left) * 4, start, start + bounds.width * 4);
  }
  return { pixels: output, width: side, height: side };
}

/** A delivery-only canvas: keep the stored photograph and every retained RGBA pixel intact. */
export async function normalizeHeroPresentation(sourceBytes: Buffer): Promise<FormattedPhoto | null> {
  const raster = await normalizeHeroPresentationRaster(sourceBytes);
  if (!raster) return null;
  const bytes = await sharp(raster.pixels, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();
  return bytes.length > maximumBytes ? null : { bytes, width: raster.width, height: raster.height };
}
