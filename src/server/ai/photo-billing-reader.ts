import 'server-only';
import Decimal from 'decimal.js';
import { z } from 'zod';
import type { PhotoBillingReadStatus } from '@/lib/photo-batch-billing-types';

export type PhotoBillingRequest = { requestId: string; createdAt: Date };
export type PhotoBillingRead = { status: PhotoBillingReadStatus; httpStatus: number | null; costs: Record<string, string> };
const pageSchema = z.object({
  billing_events: z.array(z.object({ request_id: z.string().min(1), cost_total: z.number().finite().nonnegative().nullable() })).max(10_000),
  has_more: z.boolean(), next_cursor: z.string().min(1).nullable(),
});

/** Reads billing only. No queue submissions, estimates, credential output or DB writes. */
export async function readPhotoBills(requests: PhotoBillingRequest[], options: { credential?: string; fetch?: typeof fetch; now?: Date } = {}): Promise<PhotoBillingRead> {
  if (!requests.length) return { status: 'verified', httpStatus: null, costs: {} };
  const credential = options.credential ?? process.env.FAL_BILLING_KEY ?? process.env.FAL_KEY ?? process.env.FAL_API_KEY;
  if (!credential) return { status: 'not_configured', httpStatus: null, costs: {} };
  const fetcher = options.fetch ?? fetch;
  const costs: Record<string, string> = {};
  let pending = false;
  try {
    for (let offset = 0; offset < requests.length; offset += 50) {
      const group = requests.slice(offset, offset + 50);
      const ids = new Set(group.map(item => item.requestId));
      const totals = new Map<string, Decimal>();
      const unconfirmed = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let complete = false;
      for (let page = 0; page < 10; page++) {
        const url = new URL('https://api.fal.ai/v1/models/billing-events');
        for (const id of ids) url.searchParams.append('request_id', id);
        // The provider defaults to the past 24 hours. Recovery also needs older receipts.
        url.searchParams.set('start', new Date(Math.min(...group.map(item => item.createdAt.getTime())) - 60_000).toISOString());
        url.searchParams.set('end', (options.now ?? new Date()).toISOString());
        url.searchParams.set('limit', '1000');
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetcher(url, { headers: { Authorization: `Key ${credential}` }, signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
        if (!response.ok) return { status: response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : 'unavailable', httpStatus: response.status, costs: {} };
        const parsed = pageSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.billing_events.some(event => !ids.has(event.request_id))) return { status: 'invalid', httpStatus: response.status, costs: {} };
        for (const event of parsed.data.billing_events) {
          if (event.cost_total === null) unconfirmed.add(event.request_id);
          else totals.set(event.request_id, (totals.get(event.request_id) ?? new Decimal(0)).plus(event.cost_total));
        }
        if (!parsed.data.has_more) {
          if (parsed.data.next_cursor !== null) return { status: 'invalid', httpStatus: response.status, costs: {} };
          complete = true; break;
        }
        if (!parsed.data.next_cursor || cursors.has(parsed.data.next_cursor)) return { status: 'invalid', httpStatus: response.status, costs: {} };
        cursor = parsed.data.next_cursor; cursors.add(cursor);
      }
      if (!complete) return { status: 'pending', httpStatus: 200, costs: {} };
      for (const id of ids) {
        const total = totals.get(id);
        if (!total || unconfirmed.has(id)) pending = true;
        else costs[id] = total.toFixed(8, Decimal.ROUND_CEIL);
      }
    }
    return { status: pending ? 'pending' : 'verified', httpStatus: 200, costs };
  } catch { return { status: 'unavailable', httpStatus: null, costs: {} }; }
}
