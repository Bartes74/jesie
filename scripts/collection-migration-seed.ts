import { createHash, randomUUID } from 'node:crypto';
import legacyCollections from '../migrations/0030-collections.seed.json';
import { collectionPublicDefinition, newCollectionContent, type CollectionContent } from '../src/lib/collections';

type SeedClient = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([first], [second]) => first.localeCompare(second)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export { legacyCollections };
/** Called only inside the explicit migration or a disposable local test, never on a public request. */
export async function seedLegacyCollections(client: SeedClient, timestamp = new Date()) {
  for (const definition of legacyCollections) {
    const members = definition.id === 'quick-dinners' ? [] : (await client.query(`SELECT r.id FROM editorial_recipe r
      JOIN editorial_publication p ON p.id=r.published_id
      WHERE r.publication_status='published' AND r.deleted_at IS NULL AND coalesce(p.snapshot->'recipe'->'seo'->'collectionIds','[]'::jsonb) ? $1
      ORDER BY (SELECT min(h.published_at) FROM editorial_publication h WHERE h.recipe_id=r.id) DESC,r.created_at DESC,r.id DESC`, [definition.id])).rows.map(row => String(row.id));
    const draft: CollectionContent = { ...newCollectionContent(definition.title.pl), title: definition.title, description: definition.description,
      slug: definition.slug, selectionMode: definition.id === 'quick-dinners' ? 'quick-dinners' : 'manual', recipeIds: members, minimumRecipes: 5 };
    const contentHash = createHash('sha256').update(JSON.stringify(canonical(draft))).digest('hex');
    const publicationId = randomUUID();
    await client.query(`INSERT INTO event_collection(id,content,content_hash,created_by,updated_by,updated_by_name)
      VALUES($1,$2,$3,'collection-migration','collection-migration','jesie.pl')`, [definition.id, JSON.stringify(draft), contentHash]);
    await client.query(`INSERT INTO event_collection_publication(id,collection_id,revision,snapshot,published_at,published_by,published_by_name)
      VALUES($1,$2,1,$3,$4,'collection-migration','jesie.pl')`, [publicationId, definition.id, JSON.stringify(collectionPublicDefinition(definition.id, draft, timestamp.toISOString())), timestamp]);
    await client.query(`UPDATE event_collection SET publication_status='published',published_id=$2,published_revision=1,first_published_at=$3 WHERE id=$1`, [definition.id, publicationId, timestamp]);
  }
  return legacyCollections.length;
}
