import 'server-only';
import { isLegacyMediaSource, parseLegacyMediaDeliveryWidth } from '@/lib/legacy-media-delivery';
import { getStaticMediaWidth } from './static-delivery';
import { mediaDeliveryResponse } from './delivery-response';

export function createStaticMediaRoute(deliver = getStaticMediaWidth) {
  return async (request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> => {
    const query = new URL(request.url).searchParams;
    const width = parseLegacyMediaDeliveryWidth(query);
    if (!width || [...query.keys()].some(key => key !== 'w' && key !== 'd')) return new Response(null, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    try {
      const { path } = await context.params;
      const src = `/images/${path.join('/')}`;
      if (!isLegacyMediaSource(src)) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
      const photo = await deliver(src, width);
      return mediaDeliveryResponse({ ...photo, public: true }, request.headers);
    } catch { return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } }); }
  };
}
