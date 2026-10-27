import { cronAuthorized } from '@/server/http/cron';
import { adminResponse } from '@/server/http/admin';
import { dispatchMediaMaintenance } from '@/server/media-maintenance/dispatch';

export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return adminResponse({error:'Unauthorized'},401);
  try { return adminResponse(await dispatchMediaMaintenance()); }
  catch { console.error('MEDIA_MAINTENANCE_DISPATCH_RETRY');return adminResponse({code:'MEDIA_MAINTENANCE_DISPATCH_RETRY'},503); }
}
