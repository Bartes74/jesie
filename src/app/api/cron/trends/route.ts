import { after } from 'next/server';
import { processDiscoveryOutbox } from '@/server/seo/discovery';
import { dispatchDiscoveryWorkflows } from '@/server/seo/dispatch';
import { adminResponse } from '@/server/http/admin';
import { cronAuthorized } from '@/server/http/cron';
import { dispatchDailyPreparation } from '@/server/trends/daily-dispatch';
import { trendFailure } from '@/server/trends/http';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return adminResponse({ error: 'Unauthorized' }, 401);
  after(async () => {
    try { await processDiscoveryOutbox();await dispatchDiscoveryWorkflows(); }
    catch { console.error('Discovery recovery will retry on the next daily delivery.'); }
  });
  try { return adminResponse(await dispatchDailyPreparation(), 202); }
  catch (error) { return trendFailure(error); }
}
