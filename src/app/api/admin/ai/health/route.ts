import { start } from 'workflow/api';
import { aiHealth } from '@/workflows/ai-health';
import { adminActor, adminFailure, adminResponse } from '@/server/http/admin';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    await adminActor(request, true);
    const run = await start(aiHealth, [], { region: 'fra1' });
    return adminResponse({ infrastructure: await run.returnValue });
  } catch (error) { return adminFailure(error); }
}
