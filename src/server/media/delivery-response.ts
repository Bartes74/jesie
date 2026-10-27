import 'server-only';
import { createHash } from 'node:crypto';
import type { DeliveryPhoto } from './delivery';
import { publicMediaCacheControl } from '@/server/seo/media';

/** Conditional public reads reduce repeat transfers; callers must authorize every request first. */
export function mediaDeliveryResponse(photo: DeliveryPhoto & { public: boolean }, requestHeaders: Headers): Response {
  const etag = `"${createHash('sha256').update(photo.bytes).digest('hex')}"`;
  const headers = {
    'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': photo.public ? publicMediaCacheControl : 'private, no-store',
    'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline',
    'ETag': etag,
    ...(!photo.public ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
  };
  const matches = (requestHeaders.get('If-None-Match') ?? '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
  if (photo.public && matches) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(photo.bytes), { headers: { ...headers, 'Content-Length': String(photo.bytes.length) } });
}
