import { adminActor } from '@/server/http/admin';
import { collectionFailure } from '@/server/collections/errors';
import { readCollectionAsset } from '@/server/collections/media';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    await adminActor(request); const { id, assetId } = await params;
    const asset = await readCollectionAsset(id, assetId);
    if (!asset) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    return new Response(new Uint8Array(asset.bytes), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return collectionFailure(error); }
}
