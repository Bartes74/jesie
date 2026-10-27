import { readRetainedPhotoPreview } from '@/server/ai/retained-photo-preview';
import { adminActor } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';
import { AdminAccessError } from '@/server/auth';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await adminActor(request);
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    if (site === 'cross-site' || site === 'same-site' || origin && origin !== new URL(request.url).origin) throw new AdminAccessError('Niedozwolone pochodzenie podglądu.', 403);
    const { id } = await context.params;
    const photo = await readRetainedPhotoPreview(id);
    return new Response(new Uint8Array(photo.bytes), { headers: {
      'Content-Type': photo.contentType, 'Content-Length': String(photo.bytes.byteLength),
      'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline',
    } });
  } catch (error) { return aiFailure(error); }
}
