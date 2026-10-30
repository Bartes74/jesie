import sharp from 'sharp';

const inputOptions = { limitInputPixels: 8_500_000, failOn: 'error' as const };
/** Lowest mean SSIM a lossy delivery source may have against its exact pixels. */
export const minimumDeliverySsim = 0.98;

/** Full-resolution editing source: lossless RGB and alpha, including hidden RGB. */
export async function losslessPhoto(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, inputOptions).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
}

/** q95 keeps fine texture (SSIM ≥ 0.98 on production heroes); alpha stays lossless. */
export async function lossyDeliveryPhoto(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, inputOptions).webp({ quality: 95, alphaQuality: 100, effort: 6 }).toBuffer();
}

/**
 * The archive stays lossless. Delivery sources are lossy RGB with lossless alpha
 * (alphaQuality 100): cutout silhouettes and opaque steps keep their exact alpha,
 * while variants are re-encoded lossily anyway. An unchanged studio product keeps
 * its single exact file, so its backdrop and contact shadow match the page.
 */
export async function compactPhoto(original: Buffer, formatted: Buffer, preservePixels: boolean) {
  const archive = await losslessPhoto(original);
  if (preservePixels && original.equals(formatted)) return { archive, web: archive, shared: true };
  const lossy = await lossyDeliveryPhoto(formatted);
  // Flat or synthetic artwork can compress better losslessly; then exact pixels are also smaller.
  const exact = preservePixels ? await losslessPhoto(formatted) : null;
  const web = exact && exact.length <= lossy.length ? exact : lossy;
  return { archive, web, shared: archive.equals(web) };
}

const rgba = (bytes: Buffer) => sharp(bytes, inputOptions).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const luma = (data: Buffer, index: number) => 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];

/**
 * Compares a re-encoding with its source: same dimensions, identical alpha and
 * mean SSIM of luma over 8×8 blocks that are fully visible (hidden RGB is ignored).
 */
export async function deliveryQuality(source: Buffer, encoded: Buffer) {
  const [a, b] = await Promise.all([rgba(source), rgba(encoded)]);
  const { width, height } = a.info;
  if (b.info.width !== width || b.info.height !== height) return { sameSize: false, alphaExact: false, ssim: 0 };
  let alphaExact = true;
  for (let index = 3; index < a.data.length; index += 4) if (a.data[index] !== b.data[index]) { alphaExact = false; break; }
  const c1 = 6.5025, c2 = 58.5225;
  let sum = 0, blocks = 0;
  for (let y = 0; y + 8 <= height; y += 8) for (let x = 0; x + 8 <= width; x += 8) {
    let meanA = 0, meanB = 0, hidden = false;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const index = ((y + j) * width + x + i) * 4;
      if (a.data[index + 3] === 0) hidden = true;
      meanA += luma(a.data, index); meanB += luma(b.data, index);
    }
    if (hidden) continue;
    meanA /= 64; meanB /= 64;
    let varA = 0, varB = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const index = ((y + j) * width + x + i) * 4;
      const da = luma(a.data, index) - meanA, db = luma(b.data, index) - meanB;
      varA += da * da; varB += db * db; cov += da * db;
    }
    varA /= 63; varB /= 63; cov /= 63;
    sum += ((2 * meanA * meanB + c1) * (2 * cov + c2)) / ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
    blocks++;
  }
  return { sameSize: true, alphaExact, ssim: blocks ? sum / blocks : 1 };
}
