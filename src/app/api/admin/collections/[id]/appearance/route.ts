import { after } from 'next/server';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { collectionFailure } from '@/server/collections/errors';
import { createThemeGeneration, listThemeGenerations, reconcileThemeCosts } from '@/server/collections/theme-store';
import { dispatchThemeGeneration } from '@/server/collections/theme-dispatch';
import { getCollection } from '@/server/collections/store';
export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    await adminActor(request); const { id } = await params; await getCollection(id);
    const generations = await listThemeGenerations(id);
    const pending = generations.filter(item => item.status === 'queued' || item.status === 'running');
    after(async () => {
      await Promise.allSettled(pending.map(item => dispatchThemeGeneration(item.id)));
      if (generations.some(item => item.chargedUsd === null)) await reconcileThemeCosts(id);
    });
    return adminResponse({ generations });
  } catch (error) { return collectionFailure(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const actor = await adminActor(request, true); const { id } = await params;
    const generation = await createThemeGeneration(id, await readJson(request), actor);
    after(async () => { await dispatchThemeGeneration(generation.id); });
    return adminResponse({ generation }, 202);
  } catch (error) { return collectionFailure(error); }
}
