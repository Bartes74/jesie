import { handleUsageRequest } from '@/server/seo/metrics';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleUsageRequest(request);
}
