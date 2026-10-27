import { cronAuthorized } from '@/server/http/cron';
import { adminResponse, adminFailure } from '@/server/http/admin';
import { refreshPublicReadModel } from '@/server/public/read-model';
import { processCollectionDiscovery } from '@/server/collections/discovery';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return adminResponse({ error: 'Unauthorized' }, 401);
  try {
    const snapshot = await refreshPublicReadModel();
    // Reuse the existing hourly wake-up so a failed post-publication IndexNow
    // delivery is retried even when no further editorial action occurs.
    await processCollectionDiscovery(1);
    return adminResponse(snapshot);
  } catch (error) { return adminFailure(error); }
}
