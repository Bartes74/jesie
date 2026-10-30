import sharp from 'sharp';

const inputOptions = { limitInputPixels: 8_500_000, failOn: 'error' as const };

/** Full-resolution editing source: lossless RGB and alpha, including hidden RGB. */
export async function losslessPhoto(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, inputOptions).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
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
  const lossy = await sharp(formatted, inputOptions).webp({ quality: 86, alphaQuality: 100, effort: 6 }).toBuffer();
  // Flat or synthetic artwork can compress better losslessly; then exact pixels are also smaller.
  const exact = preservePixels ? await losslessPhoto(formatted) : null;
  const web = exact && exact.length <= lossy.length ? exact : lossy;
  return { archive, web, shared: archive.equals(web) };
}
