import 'server-only';
import { createHash } from 'node:crypto';

export const referenceScopes = ['recipes', 'versions', 'publications', 'ingredient_library', 'jobs', 'photo_batches', 'trends', 'recipe_recovery', 'recovery_registry', 'variant_index', 'collections', 'collection_publications', 'collection_generations', 'collection_assets'] as const;
export type ReferenceScope = typeof referenceScopes[number];
export type ArchiveReferenceDocument = { scope: ReferenceScope; id: string; content: unknown };
export type ArchiveBlob = { pathname: string; size: number; etag: string; uploadedAt: string };
export type ArchiveAsset = { id: string; jobId: string; recipeId: string; kind: string; blobPathname: string; originalBlobPathname: string | null };
export type ArchiveJob = { id: string; status: string; input: unknown; result: unknown };
export type ArchiveCompaction = { sourcePathname: string; targetPathname: string };
export type ArchiveReferenceSnapshot = {
  capturedAt: string;
  /** True only after every required source was read successfully in one DB snapshot. */
  coverage: Record<ReferenceScope, boolean>;
  assets: ArchiveAsset[];
  jobs: ArchiveJob[];
  documents: ArchiveReferenceDocument[];
  compactions: ArchiveCompaction[];
};
export type ArchiveObjectRole = 'final_master' | 'editing_archive' | 'compacted_source' | 'recovery_source' | 'mask' | 'derivative' | 'unknown';
export type ArchiveCatalogObject = ArchiveBlob & { roles: ArchiveObjectRole[]; references: string[] };
export type ArchiveCatalog = {
  sourceStoreId: string; capturedAt: string; complete: boolean; missingScopes: ReferenceScope[];
  referenceGraphSha256: string; objects: ArchiveCatalogObject[];
  referencedPathsAbsentFromInventory: string[];
};

const assetId = '[a-f0-9-]{36}';
const validPath = (value: string) => value.length <= 2000 && /^(?:ai|seo|media-variants|media\/collections)\/[A-Za-z0-9_./-]+$/.test(value)
  && !value.split('/').some(part => !part || part === '.' || part === '..');
export const isKnownDerivativePath = (pathname: string): boolean => new RegExp(`^seo/delivery/${assetId}/v1(?:-w(?:320|640|960|1280|1600))?\\.webp$`).test(pathname)
  || /^seo\/recipes\/[a-zA-Z0-9_-]{1,128}\/v1-[a-f0-9]{32}\/[a-z0-9-]+-gotowe-(?:1600x1200|1600x900|1200x1200|1200x630|1000x1500)\.webp$/.test(pathname)
  || /^media-variants\/webp-delivery-v1\/[a-f0-9]{64}\/(?:hero|ingredient|step)\/[a-f0-9]{64}\.webp$/.test(pathname);

/** Every immutable source remains protected, even if it is absent from the current recipe. */
export function buildArchiveCatalog(sourceStoreId: string, blobs: readonly ArchiveBlob[], snapshot: ArchiveReferenceSnapshot): ArchiveCatalog {
  if (!sourceStoreId || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error('ARCHIVE_SNAPSHOT_INVALID');
  const objects = new Map<string, ArchiveCatalogObject>();
  for (const blob of blobs) {
    if (!blob.pathname || blob.pathname.length > 2000 || objects.has(blob.pathname) || !Number.isSafeInteger(blob.size) || blob.size < 0
      || !Number.isFinite(Date.parse(blob.uploadedAt))) throw new Error('ARCHIVE_INVENTORY_INVALID');
    const roles: ArchiveObjectRole[] = [];
    if (/^ai\/compact\//.test(blob.pathname)) roles.push('compacted_source');
    if (/^ai\/.+\/recovered-original\.(?:png|webp)$/.test(blob.pathname)) roles.push('recovery_source');
    if (/^ai\/.+\/(?:mask|masks)(?:[-./]|$)/.test(blob.pathname)) roles.push('mask');
    if (isKnownDerivativePath(blob.pathname)) roles.push('derivative');
    objects.set(blob.pathname, { ...blob, roles, references: [] });
  }
  const mappings = new Map<string, string>();
  for (const mapping of snapshot.compactions) {
    if (!validPath(mapping.sourcePathname) || !/^ai\/compact\/v1\/[a-f0-9]{64}\.webp$/.test(mapping.targetPathname)
      || mappings.has(mapping.sourcePathname)) throw new Error('ARCHIVE_COMPACTION_INVALID');
    mappings.set(mapping.sourcePathname, mapping.targetPathname);
  }
  const absent = new Set<string>();
  function mark(pathname: string, reference: string, role?: ArchiveObjectRole) {
    if (!validPath(pathname)) throw new Error('ARCHIVE_REFERENCE_PATH_INVALID');
    // The live reader follows one append-only mapping; both encodings stay protected if present.
    const resolved = mappings.get(pathname) ?? pathname;
    for (const target of new Set([pathname, resolved])) {
      const blob = objects.get(target);
      if (!blob) { if (target === resolved) absent.add(target); continue; }
      if (!blob.references.includes(reference)) blob.references.push(reference);
      if (role && !blob.roles.includes(role)) blob.roles.push(role);
    }
  }
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  if (assets.size !== snapshot.assets.length) throw new Error('ARCHIVE_ASSET_DUPLICATE');
  function markAsset(id: string, reference: string) {
    const asset = assets.get(id);
    if (!asset) return;
    mark(asset.blobPathname, reference, 'final_master');
    if (asset.originalBlobPathname) mark(asset.originalBlobPathname, reference, 'editing_archive');
  }
  function markJob(id: string, reference: string) {
    if (!new RegExp(`^${assetId}$`).test(id)) return;
    for (const pathname of objects.keys()) if (pathname.startsWith(`ai/${id}/`)) mark(pathname, reference);
  }
  const textReferences: { value: string; reference: string }[] = [];
  function walk(value: unknown, reference: string, key = '') {
    if (typeof value === 'string') {
      // Keep raw values in memory only; the manifest stores scope/id rather than contents or URLs.
      textReferences.push({ value, reference });
      if (validPath(value)) mark(value, reference, reference.startsWith('variant_index:') && key === 'blobPathname' ? 'derivative' : undefined);
      if (/^(?:assetId|sourceAssetId)$/.test(key)) markAsset(value, reference);
      for (const match of value.matchAll(new RegExp(`/media/(${assetId})(?=$|[/?#\\s"'<>])`, 'g'))) markAsset(match[1], reference);
      for (const match of value.matchAll(new RegExp(`/media/collections/(${assetId})(?=$|[/?#\\s"'<>])`, 'g'))) markAsset(match[1], reference);
      for (const match of value.matchAll(new RegExp(`/ai-result/(${assetId})(?=$|[/?#\\s"'<>])`, 'g'))) markJob(match[1], reference);
      if (/^(?:sourceJobId|reuseSourceJobId|recoverySourceJobId|maskJobId|jobId)$/.test(key)) markJob(value, reference);
      return;
    }
    if (Array.isArray(value)) { value.forEach(item => walk(item, reference, key)); return; }
    if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) {
      // Recovery manifests use canonical Blob pathnames as dictionary keys.
      if (validPath(childKey)) mark(childKey, reference);
      walk(child, reference, childKey);
    }
  }
  for (const asset of snapshot.assets) markAsset(asset.id, `asset:${asset.id}`);
  for (const job of snapshot.jobs) {
    // Accepted/uncertain, failed, unapplied and archived results are retained for recovery and audit.
    const reference = `job:${job.id}:${job.status}`;
    markJob(job.id, reference); walk(job.input, reference); walk(job.result, reference);
  }
  for (const document of snapshot.documents) walk(document.content, `${document.scope}:${document.id}`);
  for (const mapping of snapshot.compactions) mark(mapping.sourcePathname, `compaction:${mapping.sourcePathname}`, 'compacted_source');
  // Index literal paths once, then decode/scan each text once. A prefix trie
  // preserves substring matching (including frontend URLs and future indexed
  // paths) without multiplying every recipe/job string by every derivative.
  type PathNode = { children: Map<string, PathNode>; targets: Set<string> };
  const paths: PathNode = { children: new Map(), targets: new Set() };
  const prefixes = new Set<string>();
  for (const object of objects.values()) if (object.roles.includes('derivative')) {
    for (const literal of new Set([object.pathname, object.pathname.replace(/^seo\//, '/media/')])) {
      const slash = literal.indexOf('/', literal.startsWith('/') ? 1 : 0);
      prefixes.add(literal.slice(0, slash + 1));
      let node = paths;
      for (const character of literal) {
        let child = node.children.get(character);
        if (!child) { child = { children: new Map(), targets: new Set() }; node.children.set(character, child); }
        node = child;
      }
      node.targets.add(object.pathname);
    }
  }
  if (prefixes.size) {
    const escaped = [...prefixes].map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Lookahead keeps overlapping namespace starts: a literal can itself
    // contain another indexed pathname and both references must be retained.
    const starts = new RegExp(`(?=${escaped.join('|')})`, 'g');
    for (const { value, reference } of textReferences) {
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch { /* malformed escapes retain literal matching */ }
      for (const match of decoded.matchAll(starts)) {
        let node: PathNode | undefined = paths;
        for (let index = match.index; index < decoded.length; index++) {
          node = node.children.get(decoded[index]);
          if (!node) break;
          for (const target of node.targets) mark(target, reference);
        }
      }
    }
  }
  const sorted = [...objects.values()].map(object => ({ ...object,
    roles: (object.roles.length ? object.roles : ['unknown'] as ArchiveObjectRole[]).sort(), references: object.references.sort(),
  })).sort((a, b) => a.pathname.localeCompare(b.pathname));
  const missingScopes = referenceScopes.filter(scope => snapshot.coverage[scope] !== true);
  // Coverage describes the reference read, not the storage provider: a verified
  // application-bundle alias may satisfy a path absent from the primary store.
  // The independent backup finalizer owns that closure; GC fails closed below it.
  const complete = missingScopes.length === 0;
  const graph = sorted.map(({ pathname, size, etag, roles, references }) => ({ pathname, size, etag, roles, references }));
  return { sourceStoreId, capturedAt: snapshot.capturedAt, complete, missingScopes,
    referenceGraphSha256: createHash('sha256').update(JSON.stringify({ sourceStoreId, complete, objects: graph })).digest('hex'),
    objects: sorted, referencedPathsAbsentFromInventory: [...absent].sort() };
}

type QueryResult = { rows: Record<string, unknown>[] };
export type ArchiveReadQuery = (statement: string) => Promise<QueryResult>;

/** Caller owns BEGIN REPEATABLE READ READ ONLY, inventory timing and COMMIT/ROLLBACK. */
export async function loadArchiveReferenceSnapshot(query: ArchiveReadQuery, recoveryRegistry?: readonly unknown[]): Promise<ArchiveReferenceSnapshot> {
  const mode = await query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation");
  if (mode.rows[0]?.read_only !== 'on' || !['repeatable read', 'serializable'].includes(String(mode.rows[0]?.isolation))) throw new Error('ARCHIVE_READ_ONLY_SNAPSHOT_REQUIRED');
  const assetRows = await query('SELECT id, job_id, recipe_id, kind, blob_pathname, original_blob_pathname FROM ai_asset');
  const jobRows = await query('SELECT id, status, input, result FROM ai_job');
  const documents: ArchiveReferenceDocument[] = [];
  const sources: [ReferenceScope, string][] = [
    ['recipes', 'SELECT id, content FROM editorial_recipe'],
    ['versions', "SELECT recipe_id || ':' || revision AS id, content FROM editorial_version"],
    ['publications', 'SELECT id, snapshot AS content FROM editorial_publication'],
    ['ingredient_library', "SELECT key || ':' || asset_id AS id, jsonb_build_object('assetId',asset_id,'photo',photo,'sourceJobId',source_job_id) AS content FROM ingredient_image_catalog"],
    ['photo_batches', "SELECT id, jsonb_build_object('input',input,'slots',slots,'sourceJobId',source_job_id) AS content FROM ai_photo_batch"],
    ['trends', 'SELECT id, data AS content FROM trend_candidate'],
    ['recipe_recovery', "SELECT job_id AS id, to_jsonb(ai_recipe_recovery) AS content FROM ai_recipe_recovery"],
  ];
  const coverage = Object.fromEntries(referenceScopes.map(scope => [scope, false])) as Record<ReferenceScope, boolean>;
  for (const [scope, statement] of sources) {
    const rows = await query(statement);
    for (const row of rows.rows) documents.push({ scope, id: String(row.id), content: row.content });
    coverage[scope] = true;
  }
  coverage.jobs = true;
  // An older deployment has no derivative index. Absence is a known empty source,
  // while a failed read of a present table aborts the complete snapshot.
  const variantTable = await query("SELECT to_regclass('media_delivery_variant') AS variant_table");
  if (variantTable.rows[0]?.variant_table) {
    const variants = await query("SELECT cache_key AS id, jsonb_build_object('sourcePathname',source_pathname,'blobPathname',blob_pathname,'status',status,'assetId',asset_id) AS content FROM media_delivery_variant");
    for (const row of variants.rows) documents.push({ scope: 'variant_index', id: String(row.id), content: row.content });
  }
  coverage.variant_index = true;
  // A deployment before collections is a known empty source. A present source
  // must be read completely before any archive cleanup can be considered.
  const collectionTables = await query("SELECT to_regclass('event_collection') AS collection_table,to_regclass('collection_asset') AS collection_asset_table");
  if (collectionTables.rows[0]?.collection_table) {
    if (!collectionTables.rows[0]?.collection_asset_table) throw new Error('ARCHIVE_COLLECTION_SCHEMA_INCOMPLETE');
    for (const [scope, statement] of [
      ['collections', 'SELECT id,content FROM event_collection'],
      ['collection_publications', 'SELECT id,snapshot AS content FROM event_collection_publication'],
      ['collection_generations', 'SELECT id,to_jsonb(collection_theme_generation) AS content FROM collection_theme_generation'],
      ['collection_assets', 'SELECT id,to_jsonb(collection_asset) AS content FROM collection_asset'],
    ] as const) {
      const rows = await query(statement);
      for (const row of rows.rows) documents.push({ scope, id: String(row.id), content: row.content });
    }
    const media = await query('SELECT id,collection_id,generation_id,kind,blob_pathname FROM collection_asset');
    for (const row of media.rows) assetRows.rows.push({ id: row.id, job_id: row.generation_id ?? row.id, recipe_id: '', kind: row.kind, blob_pathname: row.blob_pathname, original_blob_pathname: null });
  }
  for (const scope of ['collections', 'collection_publications', 'collection_generations', 'collection_assets'] as const) coverage[scope] = true;
  if (recoveryRegistry !== undefined) {
    recoveryRegistry.forEach((content, index) => documents.push({ scope: 'recovery_registry', id: String(index), content }));
    coverage.recovery_registry = true;
  }
  const mappings = await query('SELECT source_pathname, target_pathname FROM media_compaction');
  return { capturedAt: new Date().toISOString(), coverage,
    assets: assetRows.rows.map(row => ({ id: String(row.id), jobId: String(row.job_id), recipeId: String(row.recipe_id), kind: String(row.kind), blobPathname: String(row.blob_pathname), originalBlobPathname: row.original_blob_pathname == null ? null : String(row.original_blob_pathname) })),
    jobs: jobRows.rows.map(row => ({ id: String(row.id), status: String(row.status), input: row.input, result: row.result })), documents,
    compactions: mappings.rows.map(row => ({ sourcePathname: String(row.source_pathname), targetPathname: String(row.target_pathname) })),
  };
}
