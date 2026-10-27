import 'server-only';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/server/db';
import { isProductionIndexable } from '@/lib/seo';
import type { CollectionTransaction } from './store';

export async function queueCollectionDiscovery(tx: CollectionTransaction, collectionId: string, paths: string[]) {
  await tx.execute(sql`INSERT INTO collection_discovery_event(id,collection_id,paths) VALUES(${randomUUID()},${collectionId},${JSON.stringify(paths)}::jsonb)`);
}
/** The same bounded processor is called after publication and by the SEO cron. */
export async function processCollectionDiscovery(limit = 5) {
  for (let index = 0; index < Math.min(20, Math.max(1, limit)); index++) {
    const token = randomUUID();
    const captured = await getDb().execute(sql`WITH candidate AS (
      SELECT id FROM collection_discovery_event WHERE completed_at IS NULL AND next_attempt_at<=clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE collection_discovery_event e SET lease_token=${token},lease_expires_at=clock_timestamp()+interval '5 minutes',attempts=attempts+1
      FROM candidate WHERE e.id=candidate.id RETURNING e.id,e.paths,e.attempts`);
    const row = captured.rows[0]; if (!row) break;
    try {
      await (await import('../public/read-model')).refreshPublicReadModel();
      for (const path of ['/pl', '/en', '/pl/kolekcje', '/en/kolekcje', '/sitemap.xml']) revalidatePath(path);
      revalidatePath('/[locale]/kolekcje/[slug]', 'page'); revalidatePath('/[locale]/recipes/[slug]', 'page');
      if (isProductionIndexable()) {
        const { configuredIndexNowKey, indexNowPayload } = await import('../seo/discovery');
        const key = configuredIndexNowKey(); if (!key) throw new Error('INDEXNOW_NOT_CONFIGURED');
        const paths = Array.isArray(row.paths) ? row.paths.filter((path): path is string => typeof path === 'string' && /^\/(pl|en)\/kolekcje\/[a-z0-9-]+$/.test(path)) : [];
        const response = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(indexNowPayload([...paths, '/pl/kolekcje', '/en/kolekcje'], key)), signal: AbortSignal.timeout(15_000), redirect: 'error' });
        if (![200, 202].includes(response.status)) throw new Error('INDEXNOW_RETRY');
      }
      await getDb().execute(sql`UPDATE collection_discovery_event SET completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=${String(row.id)} AND lease_token=${token}`);
    } catch {
      const delay = Math.min(86400, 60 * 2 ** Math.min(Number(row.attempts), 10));
      await getDb().execute(sql`UPDATE collection_discovery_event SET next_attempt_at=clock_timestamp()+${delay}*interval '1 second',lease_token=NULL,lease_expires_at=NULL,last_error='COLLECTION_DISCOVERY_RETRY' WHERE id=${String(row.id)} AND lease_token=${token}`);
    }
  }
}
