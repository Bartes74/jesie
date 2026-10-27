import { adminActor, adminResponse } from '@/server/http/admin';
import { getTrendRun } from '@/server/trends/store';
import { trendFailure } from '@/server/trends/http';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}) { try {
    await adminActor(request);
    return adminResponse(await getTrendRun((await params).id));
}
catch (error) {
    return trendFailure(error);
} }
