import { adminResponse } from '@/server/http/admin';
import { requireAdmin, getAuthOrigin, AdminAccessError } from '@/server/auth';
import { collectionFailure, CollectionError } from '@/server/collections/errors';
import { getCollection } from '@/server/collections/store';
import { inspirationMaximumBytes, saveCollectionAsset } from '@/server/collections/media';
import { readBounded } from '@/server/ai/image-provider';
import { uploadThemeHero } from '@/server/collections/theme-store';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(request.headers);
    if (request.headers.get('origin') !== getAuthOrigin() || request.headers.get('sec-fetch-site') === 'cross-site') throw new AdminAccessError('Niedozwolone pochodzenie żądania.', 403);
    const type = request.headers.get('content-type') ?? '';
    if (!type.startsWith('multipart/form-data;')) throw new AdminAccessError('Wybierz plik obrazu.', 415);
    const maximum = inspirationMaximumBytes + 65536;
    if (Number(request.headers.get('content-length') ?? 0) > maximum) throw new CollectionError(413, 'IMAGE_TOO_LARGE', 'Inspiracja może mieć najwyżej 10 MB.');
    const { id } = await params; await getCollection(id);
    const bytes = await readBounded(request.body, maximum);
    const form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': type }, body: new Uint8Array(bytes) }).formData();
    const files = form.getAll('file');
    if (files.length !== 1 || !(files[0] instanceof File)) throw new CollectionError(422, 'IMAGE_REQUIRED', 'Wybierz jeden obraz JPEG, PNG lub WebP.');
    const file = Buffer.from(await files[0].arrayBuffer());
    // ponytail: a ready-made hero shares this multipart endpoint; it is saved as a reviewable version, not applied directly.
    const text = (name: string) => { const value = form.get(name); return typeof value === 'string' ? value.trim().slice(0, 500) : ''; };
    if (form.get('purpose') === 'hero') return adminResponse({ generation: await uploadThemeHero(id, file, session.user, { pl: text('altPl'), en: text('altEn') }) }, 201);
    const asset = await saveCollectionAsset({ collectionId: id, kind: 'inspiration', bytes: file });
    return adminResponse({ assetId: asset.id, src: `/api/admin/collections/${id}/assets/${asset.id}` }, 201);
  } catch (error) { return collectionFailure(error); }
}
