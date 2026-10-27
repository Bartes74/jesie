import { adminActor, adminResponse, adminFailure } from '@/server/http/admin';
import { getPublicReadModelStatus, refreshPublicReadModel } from '@/server/public/read-model';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { await adminActor(request); return adminResponse(await getPublicReadModelStatus()); } catch (error) { return adminFailure(error); } }
export async function POST(request: Request) { try { await adminActor(request, true); return adminResponse(await refreshPublicReadModel()); } catch (error) { return adminFailure(error); } }
