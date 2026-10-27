import sharp from 'sharp';

const inputOptions = { limitInputPixels: 8_500_000, failOn: 'error' as const };

/** Full-resolution editing source: lossless RGB and alpha, including hidden RGB. */
export async function losslessPhoto(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, inputOptions).webp({ lossless: true, exact: true, effort: 6 }).toBuffer();
}

/** Cutouts and studio backdrops retain exact pixels; ordinary photos use a smaller delivery file. */
export async function compactPhoto(original: Buffer, formatted: Buffer, preservePixels: boolean) {
  const archive = await losslessPhoto(original);
  const web = preservePixels
    ? original.equals(formatted) ? archive : await losslessPhoto(formatted)
    : await sharp(formatted, inputOptions).webp({ quality: 86, alphaQuality: 100, exact: true, effort: 6 }).toBuffer();
  return { archive, web, shared: archive.equals(web) };
}
