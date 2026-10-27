import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { performCollectionAction } from '@/server/collections/store';
import { collectionFailure } from '@/server/collections/errors';
import { collectionActionInput } from '@/server/collections/validation';
import { processCollectionDiscovery } from '@/server/collections/discovery';

export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const input = collectionActionInput.parse(await readJson(request));
    const collection = await performCollectionAction((await params).id, input, actor);
    for (const path of ['/pl', '/en', '/pl/kolekcje', '/en/kolekcje', '/sitemap.xml']) revalidatePath(path);
    revalidatePath('/[locale]/kolekcje/[slug]', 'page');
    after(async () => { try { await processCollectionDiscovery(); } catch { console.error('Collection publication discovery deferred.'); } });
    return adminResponse({ collection });
  } catch (error) { return collectionFailure(error); }
}
