import { getPublishedRecipeImage, publicMediaCacheControl } from '@/server/seo/media';
import { recoverPublicRecipeVariant } from '@/server/media/public-recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string; version: string; filename: string }> }) {
  try {
    const { id, version, filename } = await context.params;
    const image = await getPublishedRecipeImage(id, version, filename);
    if (!image) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    return new Response(image.stream, { headers: {
      'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': publicMediaCacheControl, 'Content-Security-Policy': "default-src 'none'",
      'Content-Disposition': 'inline', ...(image.size ? { 'Content-Length': String(image.size) } : {}),
    } });
  } catch (error) {
    try {
      const { id, version, filename } = await context.params;
      const recovered = await recoverPublicRecipeVariant(id, version, filename, error);
      if (recovered) return recovered;
    } catch { /* Corrupt or expired emergency copies fail closed. */ }
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
