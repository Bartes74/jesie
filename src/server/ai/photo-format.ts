import 'server-only';
import sharp from 'sharp';
import type { MediaTile } from '@/lib/recipe-media';

const maximumPixels = 8_500_000;
const maximumBytes = 32 * 1024 * 1024;

export type FormattedPhoto = { bytes: Buffer; width: number; height: number };
export type PhotoBounds = { left: number; top: number; width: number; height: number };
export type CutoutValidation = {
  width: number;
  height: number;
  transparentPixels: number;
  foregroundPixels: number;
  opaquePixels: number;
  bounds: PhotoBounds;
};

export class PhotoFormatError extends Error {
  constructor(public readonly code: 'PHOTO_SOURCE_INVALID' | 'PHOTO_TILE_INVALID' | 'PHOTO_MASK_INVALID' | 'PHOTO_CUTOUT_INVALID', message: string) {
    super(message);
    this.name = 'PhotoFormatError';
  }
}

async function inspect(bytes: Buffer, mask = false) {
  const code = mask ? 'PHOTO_MASK_INVALID' : 'PHOTO_SOURCE_INVALID';
  if (!bytes.length || bytes.length > maximumBytes) throw new PhotoFormatError(code, 'Plik fotografii ma nieprawidłowy rozmiar.');
  try {
    const metadata = await sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.depth !== 'uchar' || (metadata.orientation ?? 1) !== 1) {
      throw new PhotoFormatError(code, 'Fotografia musi być pojedynczym obrazem 8-bitowym z zapisaną poprawną orientacją.');
    }
    return metadata as typeof metadata & { width: number; height: number };
  } catch (error) {
    if (error instanceof PhotoFormatError) throw error;
    throw new PhotoFormatError(code, 'Nie udało się odczytać fotografii.');
  }
}

/** Select the source tile, then crop its largest exact 7:3 rectangle. No resizing. */
export async function cropStepPhoto(sourceBytes: Buffer, tile?: Pick<MediaTile, 'columns' | 'rows' | 'index'>): Promise<FormattedPhoto> {
  const source = await inspect(sourceBytes);
  let region: PhotoBounds = { left: 0, top: 0, width: source.width, height: source.height };
  if (tile) {
    const { columns, rows, index } = tile;
    if (![columns, rows, index].every(Number.isSafeInteger) || columns < 1 || rows < 1 || index < 0 || index >= columns * rows || columns > source.width || rows > source.height) {
      throw new PhotoFormatError('PHOTO_TILE_INVALID', 'Wybrany kadr nie znajduje się w atlasie fotografii.');
    }
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = Math.floor(column * source.width / columns);
    const top = Math.floor(row * source.height / rows);
    region = {
      left, top,
      width: Math.floor((column + 1) * source.width / columns) - left,
      height: Math.floor((row + 1) * source.height / rows) - top,
    };
  }
  const units = Math.min(Math.floor(region.width / 7), Math.floor(region.height / 3));
  if (units < 1) throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Fotografia jest za mała do kadru 21:9.');
  const width = units * 7;
  const height = units * 3;
  const left = region.left + Math.floor((region.width - width) / 2);
  const top = region.top + Math.floor((region.height - height) / 2);
  try {
    const bytes = await sharp(sourceBytes, { limitInputPixels: maximumPixels, failOn: 'error' }).extract({ left, top, width, height }).png().toBuffer();
    return { bytes, width, height };
  } catch {
    throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Nie udało się odczytać pikseli fotografii.');
  }
}

async function rgba(bytes: Buffer, mask = false) {
  try {
    return await sharp(bytes, { limitInputPixels: maximumPixels, failOn: 'error' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new PhotoFormatError(mask ? 'PHOTO_MASK_INVALID' : 'PHOTO_SOURCE_INVALID', 'Nie udało się odczytać pikseli fotografii.');
  }
}

/** Use the segmentation mask only; never infer transparency from the dish's colour. */
export async function applyHeroMask(sourceBytes: Buffer, maskBytes: Buffer): Promise<FormattedPhoto> {
  const [source, mask] = await Promise.all([inspect(sourceBytes), inspect(maskBytes, true)]);
  if (mask.width * source.height !== source.width * mask.height) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Maska ma inne proporcje niż fotografia. Dopasuj geometrię maski.');
  const [{ data: pixels }, { data: maskPixels }] = await Promise.all([rgba(sourceBytes), rgba(maskBytes, true)]);
  let alphaMinimum = 255;
  let alphaMaximum = 0;
  for (let offset = 3; offset < maskPixels.length; offset += 4) {
    alphaMinimum = Math.min(alphaMinimum, maskPixels[offset]);
    alphaMaximum = Math.max(alphaMaximum, maskPixels[offset]);
  }
  // An RGBA mask can instead be an already segmented transparent image. Its
  // alpha defines the silhouette; RGB may contain actual food or black pixels.
  const useAlpha = Boolean(mask.hasAlpha) && alphaMinimum < 255;
  if (useAlpha && alphaMaximum === 0) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Maska jest całkowicie pusta.');
  let opacity = Buffer.alloc(mask.width * mask.height);
  for (let pixel = 0; pixel < opacity.length; pixel++) {
    const offset = pixel * 4;
    if (useAlpha) opacity[pixel] = maskPixels[offset + 3];
    else {
      const red = maskPixels[offset], green = maskPixels[offset + 1], blue = maskPixels[offset + 2];
      if (red !== green || red !== blue) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Nieprzezroczysta maska musi być czarno-biała, bez kolorowego podglądu.');
      opacity[pixel] = red;
    }
  }
  if (mask.width !== source.width || mask.height !== source.height) {
    // Resize the mask only. The original dish and ceramic RGB stay untouched.
    opacity = await sharp(opacity, { raw: { width: mask.width, height: mask.height, channels: 1 } })
      .resize(source.width, source.height, { kernel: sharp.kernel.lanczos3 }).greyscale().raw().toBuffer();
  }
  for (let pixel = 0; pixel < opacity.length; pixel++) {
    const offset = pixel * 4 + 3;
    pixels[offset] = Math.round(pixels[offset] * opacity[pixel] / 255);
  }
  const bytes = await sharp(pixels, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer();
  await validateCutout(bytes);
  return { bytes, width: source.width, height: source.height };
}

/** Restore enclosed vessel interiors from the opaque source; never close an open gap. */
export async function fillEnclosedCutout(sourceBytes: Buffer, cutoutBytes: Buffer): Promise<FormattedPhoto & { filledPixels: number }> {
  const [source, cutout] = await Promise.all([inspect(sourceBytes), inspect(cutoutBytes, true)]);
  if (source.width !== cutout.width || source.height !== cutout.height) {
    throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Wycięcie i oryginalna fotografia muszą mieć identyczne wymiary.');
  }
  await validateCutout(cutoutBytes);
  const [{ data: sourcePixels }, { data: cutoutPixels }] = await Promise.all([rgba(sourceBytes), rgba(cutoutBytes, true)]);
  const { width, height } = source;
  const count = width * height;
  for (let pixel = 0; pixel < count; pixel++) {
    if (sourcePixels[pixel * 4 + 3] !== 255) {
      throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Odtwarzanie wnętrza wymaga pełnego, nieprzezroczystego zdjęcia źródłowego.');
    }
  }

  const nearTransparent = 8;
  const exterior = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let head = 0, tail = 0;
  const enqueue = (pixel: number) => {
    if (!exterior[pixel] && cutoutPixels[pixel * 4 + 3] <= nearTransparent) {
      exterior[pixel] = 1;
      queue[tail++] = pixel;
    }
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width, y = Math.floor(pixel / width);
    // Eight-neighbour connectivity preserves even a diagonal opening to the
    // exterior, so this operation cannot silently seal a broken vessel edge.
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      enqueue((y + dy) * width + x + dx);
    }
  }

  let filledPixels = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * 4 + 3;
    const opacity = cutoutPixels[offset];
    if (!exterior[pixel] && opacity <= nearTransparent) {
      sourcePixels[offset] = 255;
      filledPixels++;
    } else sourcePixels[offset] = opacity;
  }
  const bytes = await sharp(sourcePixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await validateCutout(bytes);
  return { bytes, width, height, filledPixels };
}

/** A sauce boat has a food opening and a handle aperture: never fill both. */
export async function fillSauceboatInterior(sourceBytes: Buffer, cutoutBytes: Buffer): Promise<FormattedPhoto & { filledPixels: number }> {
  const [source, cutout] = await Promise.all([inspect(sourceBytes), inspect(cutoutBytes, true)]);
  if (source.width !== cutout.width || source.height !== cutout.height) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Wycięcie i oryginalna fotografia muszą mieć identyczne wymiary.');
  const { bounds } = await validateCutout(cutoutBytes);
  const [{ data: sourcePixels }, { data: cutoutPixels }] = await Promise.all([rgba(sourceBytes), rgba(cutoutBytes, true)]);
  const { width, height } = source;
  const count = width * height;
  for (let pixel = 0; pixel < count; pixel++) if (sourcePixels[pixel * 4 + 3] !== 255) throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Odtwarzanie wnętrza wymaga pełnego, nieprzezroczystego zdjęcia źródłowego.');
  const labels = new Int32Array(count);
  const queue = new Uint32Array(count);
  let head = 0, tail = 0;
  const enqueue = (pixel: number, label: number) => {
    if (labels[pixel] === 0 && cutoutPixels[pixel * 4 + 3] <= 8) { labels[pixel] = label; queue[tail++] = pixel; }
  };
  const neighbours = (pixel: number, label: number) => {
    const x = pixel % width, y = Math.floor(pixel / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      enqueue((y + dy) * width + x + dx, label);
    }
  };
  // The same eight-neighbour exterior rule as ordinary ceramic repair keeps
  // even diagonal open gaps connected to the outside.
  for (let x = 0; x < width; x++) { enqueue(x, -1); enqueue((height - 1) * width + x, -1); }
  for (let y = 0; y < height; y++) { enqueue(y * width, -1); enqueue(y * width + width - 1, -1); }
  while (head < tail) neighbours(queue[head++], -1);
  const components: Array<{ label: number; area: number; left: number; top: number; width: number; height: number; cx: number; cy: number }> = [];
  for (let seed = 0; seed < count; seed++) {
    if (labels[seed] !== 0 || cutoutPixels[seed * 4 + 3] > 8) continue;
    const label = components.length + 1;
    head = 0; tail = 0; enqueue(seed, label);
    let left = width, top = height, right = 0, bottom = 0, sumX = 0, sumY = 0;
    while (head < tail) {
      const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); sumX += x; sumY += y;
      neighbours(pixel, label);
    }
    components.push({ label, area: tail, left, top, width: right - left + 1, height: bottom - top + 1, cx: sumX / tail, cy: sumY / tail });
  }
  const boundsArea = bounds.width * bounds.height;
  const significant = components.filter(component => component.area >= Math.max(4, boundsArea * 0.002)).sort((a, b) => b.area - a.area);
  let fillLabel = 0;
  const fail = () => { throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Nie można pewnie odróżnić sosu od otworu uchwytu. Zachowano źródło; sprawdź maskę sosjerki.'); };
  if (significant.length >= 2) {
    const [food, handle] = significant;
    // A readable three-quarter food surface is broad, in the upper body, and
    // clearly larger than every handle opening. Ambiguity stops the correction.
    if (food.area < boundsArea * 0.05 || food.area < handle.area * 3 || food.width < food.height * 1.5
      || food.cx < bounds.left + bounds.width * 0.18 || food.cx > bounds.left + bounds.width * 0.72
      || food.cy < bounds.top + bounds.height * 0.05 || food.cy > bounds.top + bounds.height * 0.62) fail();
    fillLabel = food.label;
  } else {
    const opening = significant[0];
    if (opening && (opening.area > boundsArea * 0.18 || opening.width >= opening.height
      || opening.cx >= bounds.left + bounds.width * 0.35 && opening.cx <= bounds.left + bounds.width * 0.65)) fail();
    // With only an obvious peripheral handle hole (or none), the central food
    // must already be retained. An open sauce-surface mask cannot be repaired.
    let samples = 0, retained = 0;
    for (let y = Math.ceil(bounds.top + bounds.height * 0.15); y < bounds.top + bounds.height * 0.4; y++) {
      for (let x = Math.ceil(bounds.left + bounds.width * 0.25); x < bounds.left + bounds.width * 0.65; x++) {
        samples++; if (cutoutPixels[(y * width + x) * 4 + 3] > 8) retained++;
      }
    }
    if (!samples || retained / samples < 0.25) fail();
  }
  let filledPixels = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    if (fillLabel && labels[pixel] === fillLabel) { sourcePixels[pixel * 4 + 3] = 255; filledPixels++; }
    else sourcePixels[pixel * 4 + 3] = cutoutPixels[pixel * 4 + 3];
  }
  const bytes = await sharp(sourcePixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await validateCutout(bytes);
  return { bytes, width, height, filledPixels };
}

/** Restore a clearly enclosed food opening without filling peripheral handle gaps. */
export async function fillCookwareInterior(sourceBytes: Buffer, cutoutBytes: Buffer): Promise<FormattedPhoto & { filledPixels: number }> {
  // Reuse the eight-neighbour exterior rule: even a diagonal leak stays open.
  // The fully filled image is only an enclosure map, never the returned mask.
  const enclosed = await fillEnclosedCutout(sourceBytes, cutoutBytes);
  const { bounds } = await validateCutout(cutoutBytes);
  const [{ data: pixels }, { data: cutout }] = await Promise.all([rgba(enclosed.bytes), rgba(cutoutBytes, true)]);
  const { width, height } = enclosed;
  const count = width * height;
  const labels = new Int32Array(count);
  const queue = new Uint32Array(count);
  const components: Array<{ label: number; area: number; width: number; height: number; cx: number; cy: number }> = [];
  for (let seed = 0; seed < count; seed++) {
    if (labels[seed] || cutout[seed * 4 + 3] > 8 || pixels[seed * 4 + 3] !== 255) continue;
    const label = components.length + 1;
    let head = 0, tail = 0, left = width, top = height, right = 0, bottom = 0, sumX = 0, sumY = 0;
    const enqueue = (pixel: number) => {
      if (!labels[pixel] && cutout[pixel * 4 + 3] <= 8 && pixels[pixel * 4 + 3] === 255) { labels[pixel] = label; queue[tail++] = pixel; }
    };
    enqueue(seed);
    while (head < tail) {
      const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); sumX += x; sumY += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        enqueue((y + dy) * width + x + dx);
      }
    }
    components.push({ label, area: tail, width: right - left + 1, height: bottom - top + 1, cx: sumX / tail, cy: sumY / tail });
  }
  components.sort((a, b) => b.area - a.area);
  const [food, next] = components;
  const boundsArea = bounds.width * bounds.height;
  // A food opening is broad, central, substantial, and clearly larger than
  // any handle aperture. A pot with solid handles can have just this one hole.
  const centralFood = food && food.area >= boundsArea * 0.05 && food.area <= boundsArea * 0.7
    && food.width >= bounds.width * 0.25 && food.height >= bounds.height * 0.1 && food.width >= food.height * 0.8
    && food.cx >= bounds.left + bounds.width * 0.25 && food.cx <= bounds.left + bounds.width * 0.75
    && food.cy >= bounds.top + bounds.height * 0.1 && food.cy <= bounds.top + bounds.height * 0.72;
  if (centralFood && next && food.area < next.area * 3) {
    throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Nie można pewnie odróżnić potrawy od otworów uchwytów. Zachowano źródło; sprawdź maskę naczynia.');
  }
  let filledPixels = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    if (centralFood && labels[pixel] === food.label) { pixels[pixel * 4 + 3] = 255; filledPixels++; }
    else pixels[pixel * 4 + 3] = cutout[pixel * 4 + 3];
  }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  // An open or ambiguous food surface must still fail; never invent its edge.
  await validateSolidHeroCutout(bytes);
  return { bytes, width, height, filledPixels };
}

/** A manual composition may keep its background, but an invisible result is never a usable photograph. */
export async function validateVisiblePhoto(bytes: Buffer): Promise<void> {
  const metadata = await inspect(bytes);
  if (!metadata.hasAlpha) return;
  const { data } = await rgba(bytes);
  let visible = 0;
  for (let offset = 3; offset < data.length; offset += 4) if (data[offset] >= 250) visible++;
  if (visible < Math.max(4, metadata.width * metadata.height * 0.01)) {
    throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Fotografia jest pusta lub nie zachowuje widocznej potrawy.');
  }
}

/** Technical alpha checks only. These cannot establish which object was cut out. */
export async function validateCutout(bytes: Buffer): Promise<CutoutValidation> {
  const metadata = await inspect(bytes);
  if (!metadata.hasAlpha) throw new PhotoFormatError('PHOTO_CUTOUT_INVALID', 'Wycięcie nie ma kanału przezroczystości.');
  const { data } = await rgba(bytes);
  const { width, height } = metadata;
  let transparentPixels = 0, foregroundPixels = 0, opaquePixels = 0;
  let left = width, top = height, right = -1, bottom = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const alpha = data[pixel * 4 + 3];
    if (alpha === 0) transparentPixels++;
    else {
      foregroundPixels++;
      // Generated cutouts can retain alpha 250–254 throughout a solid subject.
      // Match the retained-food threshold below; validation never alters pixels.
      if (alpha >= 250) opaquePixels++;
      const x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  if (!transparentPixels || foregroundPixels < 4 || !opaquePixels || corners.some(pixel => data[pixel * 4 + 3] !== 0)) {
    throw new PhotoFormatError('PHOTO_CUTOUT_INVALID', 'Wycięcie jest puste, nie ma nieprzezroczystego wnętrza albo pozostawia tło w rogach.');
  }
  return { width, height, transparentPixels, foregroundPixels, opaquePixels, bounds: { left, top, width: right - left + 1, height: bottom - top + 1 } };
}

/** For solid ceramic heroes: a retained rim alone must not count as a dish. */
export async function validateSolidHeroCutout(bytes: Buffer): Promise<CutoutValidation> {
  const checked = await validateCutout(bytes);
  const { data } = await rgba(bytes);
  const { bounds, width } = checked;
  let samples = 0, retained = 0;
  for (let y = Math.ceil(bounds.top + bounds.height * 0.3); y < bounds.top + bounds.height * 0.7; y++) {
    for (let x = Math.ceil(bounds.left + bounds.width * 0.3); x < bounds.left + bounds.width * 0.7; x++) {
      samples++; if (data[(y * width + x) * 4 + 3] >= 250) retained++;
    }
  }
  if (!samples || retained / samples < 0.9) throw new PhotoFormatError('PHOTO_CUTOUT_INVALID', 'Wycięcie usuwa środek potrawy lub naczynia. Zachowano oryginał; sprawdź całą potrawę przed zapisem.');
  return checked;
}

/** A glass hero must retain visible food in its upper body, not just its rim and stem. */
export async function validateGlassHeroCutout(bytes: Buffer): Promise<CutoutValidation> {
  const checked = await validateCutout(bytes);
  const { data } = await rgba(bytes);
  const { bounds, width } = checked;
  let samples = 0, retained = 0;
  // This is a rejection gate only. Do not fill the glass walls, stem or foot:
  // their original alpha can be intentional. Count contents with at least 25%
  // opacity as retained too; this gate must not turn transparent drinks into solids.
  // SAM's vessel-only mask can omit
  // the complete food surface while its lower bowl still passes solid checks.
  for (let y = Math.ceil(bounds.top + bounds.height * 0.2); y < bounds.top + bounds.height * 0.55; y++) {
    for (let x = Math.ceil(bounds.left + bounds.width * 0.35); x < bounds.left + bounds.width * 0.65; x++) {
      samples++; if (data[(y * width + x) * 4 + 3] >= 64) retained++;
    }
  }
  if (!samples || retained / samples < 0.9) throw new PhotoFormatError('PHOTO_CUTOUT_INVALID', 'Wycięcie usuwa zawartość kieliszka lub szklanki. Zachowano oryginał; sprawdź całą potrawę przed zapisem.');
  return checked;
}

/** Explicitly reviewed narrow seams only; never infer the food boundary from colour. */
export async function fillReviewedHeroSeams(sourceBytes: Buffer, cutoutBytes: Buffer, bridges: readonly PhotoBounds[]) {
  const checked = await validateCutout(cutoutBytes);
  const source = await inspect(sourceBytes);
  if (source.width !== checked.width || source.height !== checked.height) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Wycięcie i źródło muszą mieć identyczne wymiary.');
  const { bounds } = checked;
  if (!bridges.length || bridges.length > 8 || bridges.some(bridge => !Object.values(bridge).every(Number.isSafeInteger)
    || bridge.width < 1 || bridge.height < 1 || bridge.left < bounds.left || bridge.top < bounds.top
    || bridge.left + bridge.width > bounds.left + bounds.width || bridge.top + bridge.height > bounds.top + bounds.height)
    || bridges.reduce((sum, bridge) => sum + bridge.width * bridge.height, 0) > bounds.width * bounds.height * 0.01) {
    throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Mostek może zamknąć wyłącznie małą, ręcznie sprawdzoną przerwę w brzegu naczynia.');
  }
  const [{ data: sourcePixels }, { data: maskPixels }] = await Promise.all([rgba(sourceBytes), rgba(cutoutBytes, true)]);
  for (let pixel = 0; pixel < checked.width * checked.height; pixel++) {
    if (sourcePixels[pixel * 4 + 3] !== 255) throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Odtwarzanie wymaga pełnego, nieprzezroczystego zdjęcia źródłowego.');
    sourcePixels[pixel * 4 + 3] = maskPixels[pixel * 4 + 3];
  }
  let bridgedPixels = 0;
  for (const bridge of bridges) {
    let retained = 0, transparent = 0;
    for (let y = bridge.top; y < bridge.top + bridge.height; y++) for (let x = bridge.left; x < bridge.left + bridge.width; x++) {
      const offset = (y * checked.width + x) * 4 + 3;
      if (maskPixels[offset] > 8) retained++; else transparent++;
      if (sourcePixels[offset] !== 255) { sourcePixels[offset] = 255; bridgedPixels++; }
    }
    if (!retained || !transparent) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Mostek musi obejmować potwierdzoną przerwę i zachowany brzeg tego samego naczynia.');
  }
  const bridged = await sharp(sourcePixels, { raw: { width: checked.width, height: checked.height, channels: 4 } }).png().toBuffer();
  const result = await fillEnclosedCutout(sourceBytes, bridged);
  await validateSolidHeroCutout(result.bytes);
  return { ...result, bridgedPixels };
}

/** An operator-reviewed round vessel outline; copy every RGB pixel, change alpha only. */
export async function maskReviewedRoundVessel(sourceBytes: Buffer, outline: PhotoBounds): Promise<FormattedPhoto> {
  const source = await inspect(sourceBytes);
  if (!Object.values(outline).every(Number.isSafeInteger) || outline.left < 1 || outline.top < 1 || outline.width < 4 || outline.height < 4
    || outline.left + outline.width >= source.width || outline.top + outline.height >= source.height
    || outline.width / outline.height < 0.8 || outline.width / outline.height > 1.25) throw new PhotoFormatError('PHOTO_MASK_INVALID', 'Wskaż ręcznie sprawdzony, kompletny obrys okrągłego naczynia wewnątrz fotografii.');
  const { data } = await rgba(sourceBytes);
  const cx = outline.left + outline.width / 2, cy = outline.top + outline.height / 2;
  const rx = outline.width / 2, ry = outline.height / 2;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const offset = (y * source.width + x) * 4 + 3;
    if (data[offset] !== 255) throw new PhotoFormatError('PHOTO_SOURCE_INVALID', 'Obrys wymaga pełnego, nieprzezroczystego zdjęcia źródłowego.');
    const radialDistance = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
    const edgeDistance = (1 - radialDistance) * Math.min(rx, ry);
    data[offset] = Math.round(Math.max(0, Math.min(1, edgeDistance + 0.5)) * 255);
  }
  const bytes = await sharp(data, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer();
  await validateSolidHeroCutout(bytes);
  return { bytes, width: source.width, height: source.height };
}
