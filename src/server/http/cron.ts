import { timingSafeEqual } from 'node:crypto';

export function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret ?? ''}`;
  return Boolean(secret && Buffer.byteLength(supplied) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
}
