import sharp from 'sharp';
import { getMediaBlob } from '@/server/media/storage';
import { readBounded } from '@/server/ai/image-provider';
import { collectionAssetPath, collectionAssetPattern } from '@/server/collections/media';
import { publicCollectionDefinitions } from '@/server/public/collections';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const { assetId } = await params;
  if (!collectionAssetPattern.test(assetId)) return new Response(null, { status: 404, headers });
  const width = new URL(request.url).searchParams.get('w');
  if (width && !['320', '640', '960', '1280', '1600'].includes(width)) return new Response(null, { status: 400, headers });
  try {
    const collections = await publicCollectionDefinitions();
    const publicAsset = collections.some(collection => collection.theme?.hero.assetId === assetId || collection.theme?.atmosphere?.assetId === assetId);
    if (!publicAsset) return new Response(null, { status: 404, headers });
    const stored = await getMediaBlob(collectionAssetPath(assetId));
    if (!stored || stored.statusCode !== 200) return new Response(null, { status: 503, headers });
    let bytes = await readBounded(stored.stream, 32 * 1024 * 1024);
    if (width) bytes = await sharp(bytes).resize({ width: Number(width), withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=0, s-maxage=300, must-revalidate' } });
  } catch { return new Response(null, { status: 503, headers }); }
}
