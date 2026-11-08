import { cronAuthorized } from '@/server/http/cron';
import { adminResponse } from '@/server/http/admin';
import { reconcileDailySearchReceipts, recoverDailyRecipeDrafts, retryDailyPreparationDispatch } from '@/server/trends/daily-draft-recovery';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return adminResponse({ error: 'Unauthorized' }, 401);
  const [drafts, dispatch, research] = await Promise.allSettled([
    recoverDailyRecipeDrafts(), retryDailyPreparationDispatch(), reconcileDailySearchReceipts(),
  ]);
  if (research.status === 'rejected') console.warn(JSON.stringify({ event: 'daily_search_reconciliation_unavailable' }));
  if (drafts.status === 'rejected' || dispatch.status === 'rejected') {
    console.error(JSON.stringify({ event: 'daily_preparation_recovery_failed', drafts: drafts.status, dispatch: dispatch.status }));
    return adminResponse({ error: 'DAILY_PREPARATION_RECOVERY_UNAVAILABLE' }, 503);
  }
  return adminResponse({ ...drafts.value, dispatched: dispatch.value });
}
