import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { EditorialContent } from '../src/lib/editorial-types';
import type { MediaTile } from '../src/lib/recipe-media';
import { citrusRepairHash as hash, citrusRepairInventory as inventory, recipePhotoRepairPlanState, type CitrusRepairRecipe as Recipe, type RecipePhotoRepairPlanState } from './repair-citrus-ingredient-photos';

export type IngredientPhotoRepairRule = { recipeId: string; ingredientId: string; scope: 'draft' | 'publication' | 'both'; before: MediaTile | null; after: MediaTile; review: string };
export type IngredientPhotoRepairManifest = { version: 1; reason: string; rules: IngredientPhotoRepairRule[]; rejectAssets: string[] };
type Catalog = { key: string; product: string; form: string; style_profile: string; asset_id: string; source_job_id: string; photo: MediaTile; eligibility: string; created_at: string };
type Asset = { id: string; recipe_id: string; kind: string; blob_pathname: string; original_blob_pathname: string | null; width: number; height: number };
type Proof = { src: string; sha256: string; bytes: number; width: number; height: number; asset?: Asset };
type Change = { ingredientId: string; before: MediaTile | null; after: MediaTile; review: string };
type Record = { recipeId: string; title: string; nextRevision: number; draft: Change[]; publication: Change[]; nextContentHash: string;
  nextPublicationHash: string | null; publicationId: string | null; auditId: string; outboxId: string | null };
export type IngredientPhotoRepairPlan = Omit<RecipePhotoRepairPlanState, 'records'> & { version: 1; planId: string; createdAt: string; databaseScope: string;
  manifest: IngredientPhotoRepairManifest; manifestSha256: string; proofs: Proof[]; records: Record[]; beforeCatalog: Catalog[]; afterCatalog: Catalog[];
  quarantineAudits: { id: string; assetId: string; recipeId: string; revision: number }[] };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function assert(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
const uuid = (value: string) => /^[a-f0-9-]{36}$/i.test(value);

export function validateIngredientPhotoRepairManifest(value: IngredientPhotoRepairManifest) {
  assert(value.version === 1 && typeof value.reason === 'string' && value.reason.trim() && value.reason.length <= 2000
    && Array.isArray(value.rules) && Array.isArray(value.rejectAssets), 'MANIFEST_INVALID');
  assert(value.rules.length + value.rejectAssets.length > 0 && value.rules.length <= 2000, 'MANIFEST_EMPTY_OR_TOO_LARGE');
  assert(new Set(value.rejectAssets).size === value.rejectAssets.length && value.rejectAssets.every(uuid), 'REJECT_ASSETS_INVALID');
  const scopes = new Set<string>();
  for (const rule of value.rules) {
    assert(typeof rule.recipeId === 'string' && rule.recipeId && typeof rule.ingredientId === 'string' && rule.ingredientId
      && ['draft', 'publication', 'both'].includes(rule.scope) && typeof rule.review === 'string' && rule.review.trim(), 'RULE_INVALID');
    assert(rule.after && /^\/(?:images\/[A-Za-z0-9_./-]+|media\/[a-f0-9-]{36})$/.test(rule.after.src)
      && !rule.after.src.includes('..') && rule.after.columns === 1 && rule.after.rows === 1 && rule.after.index === 0
      && rule.after.alt?.pl?.trim() && rule.after.alt?.en?.trim(), 'REPLACEMENT_INVALID');
    if (rule.after.src.startsWith('/media/')) assert(!value.rejectAssets.includes(rule.after.src.slice(7)), 'REJECTED_REPLACEMENT');
    for (const scope of rule.scope === 'both' ? ['draft', 'publication'] : [rule.scope]) {
      const key = JSON.stringify([rule.recipeId, rule.ingredientId, scope]); assert(!scopes.has(key), 'OVERLAPPING_RULES'); scopes.add(key);
    }
  }
}

/** Exact recipe/ingredient/scope selectors; no text, quantities or other photos can change. */
export function patchReviewedIngredientPhotos(content: EditorialContent, recipeId: string, scope: 'draft' | 'publication', manifest: IngredientPhotoRepairManifest) {
  const next = structuredClone(content), changes: Change[] = [];
  for (const rule of manifest.rules.filter(rule => rule.recipeId === recipeId && (rule.scope === 'both' || rule.scope === scope))) {
    assert(content.recipe.ingredients.some(item => item.id === rule.ingredientId), `INGREDIENT_MISSING:${rule.ingredientId}`);
    const before = content.photos.ingredients[rule.ingredientId] ?? null;
    if (same(before, rule.after)) continue;
    assert(same(before, rule.before), `PHOTO_CHANGED:${rule.ingredientId}`);
    next.photos.ingredients[rule.ingredientId] = structuredClone(rule.after);
    changes.push({ ingredientId: rule.ingredientId, before: structuredClone(before), after: structuredClone(rule.after), review: rule.review });
  }
  return { content: next, changes };
}

export function buildIngredientPhotoRepairPlan(recipes: Recipe[], manifest: IngredientPhotoRepairManifest, context: { actor: { id: string; name: string }; databaseScope: string;
  manifestSha256: string; proofs: Proof[]; catalog: Catalog[]; assets: Asset[] }): IngredientPhotoRepairPlan {
  validateIngredientPhotoRepairManifest(manifest);
  const active = recipes.filter(row => !row.deleted_at), before = inventory(active), after = structuredClone(before), records: Record[] = [];
  for (const rule of manifest.rules) {
    const row = active.find(row => row.id === rule.recipeId); assert(row, `RECIPE_OUTSIDE_SCOPE:${rule.recipeId}`);
    if (rule.scope !== 'draft') assert(row.publication_status === 'published' && row.publication, `PUBLICATION_OUTSIDE_SCOPE:${rule.recipeId}`);
  }
  for (const row of active) {
    const draft = patchReviewedIngredientPhotos(row.content, row.id, 'draft', manifest);
    const publication = row.publication_status === 'published' && row.publication ? patchReviewedIngredientPhotos(row.publication.snapshot, row.id, 'publication', manifest) : null;
    if (!draft.changes.length && !publication?.changes.length) continue;
    const nextRevision = row.revision + 1, publicationId = publication?.changes.length ? randomUUID() : null;
    const record: Record = { recipeId: row.id, title: row.content.recipe.title.pl, nextRevision, draft: draft.changes, publication: publication?.changes ?? [],
      nextContentHash: hash(draft.content), nextPublicationHash: publicationId ? hash(publication!.content) : null, publicationId,
      auditId: randomUUID(), outboxId: publicationId ? randomUUID() : null };
    records.push(record);
    const expected = after.find(item => item.id === row.id)!;
    expected.revision = nextRevision; expected.content_hash = record.nextContentHash;
    if (row.checks_revision === row.revision) expected.checks_revision = nextRevision;
    if (row.approved_revision === row.revision) expected.approved_revision = nextRevision;
    if (publicationId) {
      expected.published_id = publicationId; expected.published_revision = nextRevision;
      expected.publication = { ...expected.publication!, id: publicationId, revision: nextRevision, content_hash: record.nextPublicationHash!,
        approval_origin: 'manual', published_by: context.actor.id, published_by_name: context.actor.name };
    }
  }
  const beforeCatalog = structuredClone(context.catalog).sort((a, b) => `${a.asset_id}:${a.key}`.localeCompare(`${b.asset_id}:${b.key}`));
  assert(beforeCatalog.every(row => manifest.rejectAssets.includes(row.asset_id)), 'CATALOG_SCOPE_INVALID');
  const afterCatalog = beforeCatalog.map(row => ({ ...structuredClone(row), eligibility: 'rejected' }));
  const quarantineAudits = manifest.rejectAssets.filter(id => beforeCatalog.some(row => row.asset_id === id && row.eligibility !== 'rejected')).map(assetId => {
    const asset = context.assets.find(item => item.id === assetId), state = after.find(row => row.id === asset?.recipe_id);
    assert(asset && state, 'QUARANTINE_SOURCE_OUTSIDE_SCOPE');
    return { id: randomUUID(), assetId, recipeId: state.id, revision: state.revision };
  });
  const { catalog, assets, ...metadata } = context; void catalog; void assets;
  return { version: 1, planId: randomUUID(), createdAt: new Date().toISOString(), ...metadata, manifest: structuredClone(manifest), before, after, records,
    beforeCatalog, afterCatalog, quarantineAudits };
}

export function ingredientPhotoRepairPlanState(plan: IngredientPhotoRepairPlan, recipes: Recipe[], catalog: Catalog[]): 'before' | 'after' {
  const state = recipePhotoRepairPlanState(plan, recipes);
  const actual = [...catalog].sort((a, b) => `${a.asset_id}:${a.key}`.localeCompare(`${b.asset_id}:${b.key}`));
  assert(same(plan.afterCatalog, plan.beforeCatalog.map(row => ({ ...row, eligibility: 'rejected' }))), 'PLANNED_CATALOG_INVALID');
  if (same(actual, state === 'before' ? plan.beforeCatalog : plan.afterCatalog)) return state;
  // Catalog-only repairs have no editorial revision delta.
  if (!plan.records.length && state === 'before' && same(actual, plan.afterCatalog)) return 'after';
  throw Error('CATALOG_INVENTORY_CHANGED');
}

const option = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
async function main() {
  const mode = ['--prepare', '--preflight', '--apply'].filter(value => process.argv.includes(value)); assert(mode.length === 1, 'CHOOSE_ONE_MODE');
  const planPath = option('--plan'); assert(planPath, 'PLAN_REQUIRED');
  config({ path: option('--env') ?? '.env.production.local', quiet: true }); assert(process.env.DATABASE_URL, 'DATABASE_REQUIRED');
  const url = new URL(process.env.DATABASE_URL), databaseScope = hash(`${url.host}${url.pathname}:${url.username}`);
  url.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = url.href;
  let reviewed: IngredientPhotoRepairPlan | undefined, manifest: IngredientPhotoRepairManifest, manifestSha256: string, planSha256: string | undefined;
  if (mode[0] === '--prepare') {
    const path = option('--manifest'); assert(path, 'MANIFEST_REQUIRED'); const bytes = await readFile(resolve(path));
    manifest = JSON.parse(bytes.toString()) as IngredientPhotoRepairManifest; manifestSha256 = sha(bytes);
  } else {
    const bytes = await readFile(resolve(planPath)); planSha256 = sha(bytes); assert(option('--plan-sha256') === planSha256, 'EXACT_PLAN_SHA256_REQUIRED');
    reviewed = JSON.parse(bytes.toString()) as IngredientPhotoRepairPlan;
    assert(reviewed.version === 1 && uuid(reviewed.planId) && reviewed.databaseScope === databaseScope, 'PLAN_SCOPE_INVALID');
    manifest = reviewed.manifest; manifestSha256 = reviewed.manifestSha256;
  }
  validateIngredientPhotoRepairManifest(manifest);
  const { getDb, closeDb } = await import('../src/server/db');
  const { contentApprovalHash } = await import('../src/server/editorial/content-approval');
  const { invalidatePublicReadModel, refreshPublicReadModel } = await import('../src/server/public/read-model');
  const { getMediaBlob } = await import('../src/server/media/storage');
  try {
    const replacementAssets = new Map<string, Asset>();
    const afterSources = [...new Set(manifest.rules.map(rule => rule.after.src))].sort();
    for (const src of afterSources.filter(src => src.startsWith('/media/'))) {
      const rows = await getDb().execute(sql`SELECT id,recipe_id,kind,blob_pathname,original_blob_pathname,width,height FROM ai_asset WHERE id=${src.slice(7)}`);
      const asset = rows.rows[0] as Asset | undefined; assert(asset?.kind === 'ingredient', 'REPLACEMENT_ASSET_INVALID'); replacementAssets.set(src, asset);
    }
    const proofs: Proof[] = [];
    for (const src of afterSources) {
      const asset = replacementAssets.get(src);
      let bytes: Buffer;
      if (asset) { const blob = await getMediaBlob(asset.blob_pathname, { useCache: false }); assert(blob?.statusCode === 200, 'REPLACEMENT_UNAVAILABLE');
        assert(blob.blob.size <= 32 * 1024 * 1024, 'REPLACEMENT_TOO_LARGE'); bytes = Buffer.from(await new Response(blob.stream).arrayBuffer()); }
      else bytes = await readFile(resolve(`public${src}`));
      const info = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
      assert(info.width && info.height && (info.pages ?? 1) === 1, 'REPLACEMENT_IMAGE_INVALID');
      proofs.push({ src, sha256: sha(bytes), bytes: bytes.length, width: info.width, height: info.height, ...(asset ? { asset } : {}) });
    }
    if (reviewed) assert(same(proofs, reviewed.proofs), 'REPLACEMENT_PROOFS_CHANGED');
    const result = await getDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='10s'`);
      if (mode[0] === '--apply') await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('repair-reviewed-ingredient-photos-v1'))`);
      const owners = (await tx.execute(sql`SELECT id,name FROM auth_user WHERE role='owner' AND NOT disabled ORDER BY id`)).rows as { id: string; name: string }[];
      assert(owners.length === 1, 'OWNER_AMBIGUOUS'); const actor = owners[0];
      const current = (await tx.execute(mode[0] === '--apply' ? sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`
        : sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id`)).rows as Omit<Recipe, 'publication'>[];
      const publications = (await tx.execute(sql`SELECT p.* FROM editorial_publication p JOIN editorial_recipe r ON r.published_id=p.id
        WHERE r.deleted_at IS NULL AND r.publication_status='published' ORDER BY p.id`)).rows as NonNullable<Recipe['publication']>[];
      const rows: Recipe[] = current.map(row => ({ ...row, publication: publications.find(item => item.id === row.published_id) ?? null }));
      const catalog = (await tx.execute(sql`SELECT key,product,form,style_profile,asset_id,source_job_id,photo,eligibility,created_at::text AS created_at
        FROM ingredient_image_catalog WHERE asset_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(manifest.rejectAssets)}::jsonb)) ORDER BY asset_id,key`)).rows as Catalog[];
      const assets = (await tx.execute(sql`SELECT id,recipe_id,kind,blob_pathname,original_blob_pathname,width,height FROM ai_asset
        WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(manifest.rejectAssets)}::jsonb))`)).rows as Asset[];
      assert(assets.length === manifest.rejectAssets.length, 'QUARANTINE_ASSET_MISSING');
      if (!reviewed) {
        const plan = buildIngredientPhotoRepairPlan(rows, manifest, { actor, databaseScope, manifestSha256, proofs, catalog, assets });
        const bytes = Buffer.from(JSON.stringify(plan, null, 2)); await writeFile(resolve(planPath), bytes, { mode: 0o600, flag: 'wx' });
        return { mode: mode[0], productionMutation: false, planSha256: sha(bytes), considered: rows.length, changedRecipes: plan.records.length,
          changedPublications: plan.records.filter(row => row.publicationId).length, changedDraftTiles: plan.records.reduce((sum, row) => sum + row.draft.length, 0),
          changedPublicTiles: plan.records.reduce((sum, row) => sum + row.publication.length, 0), rejectedCatalogRows: catalog.filter(row => row.eligibility !== 'rejected').length };
      }
      const plan = reviewed; assert(same(actor, plan.actor), 'OWNER_CHANGED');
      const state = ingredientPhotoRepairPlanState(plan, rows, catalog), action = `repair_ingredient_photos:${plan.planId}`;
      const expectedAudits = [...plan.records.map(row => ({ id: row.auditId, recipeId: row.recipeId, revision: row.nextRevision })),
        ...plan.quarantineAudits.map(row => ({ id: row.id, recipeId: row.recipeId, revision: row.revision }))].sort((a, b) => a.id.localeCompare(b.id));
      const receipts = (await tx.execute(sql`SELECT id,recipe_id,revision FROM editorial_audit WHERE action=${action} ORDER BY id`)).rows
        .map(row => ({ id: row.id, recipeId: row.recipe_id, revision: row.revision }));
      if (state === 'after') {
        assert(same(receipts, expectedAudits), 'APPLIED_RECEIPTS_MISSING');
        return { mode: mode[0], productionMutation: false, alreadyApplied: true, planSha256, changedRecipes: plan.records.length,
          changedPublications: plan.records.filter(row => row.publicationId).length };
      }
      assert(!receipts.length, 'PARTIAL_APPLICATION_RECEIPT');
      const changes = plan.records.map(record => {
        const original = rows.find(row => row.id === record.recipeId); assert(original, 'PLANNED_RECIPE_MISSING');
        const draft = patchReviewedIngredientPhotos(original.content, original.id, 'draft', manifest);
        const publication = original.publication_status === 'published' && original.publication ? patchReviewedIngredientPhotos(original.publication.snapshot, original.id, 'publication', manifest) : null;
        assert(same(draft.changes, record.draft) && same(publication?.changes ?? [], record.publication) && hash(draft.content) === record.nextContentHash
          && (!record.publicationId || publication && hash(publication.content) === record.nextPublicationHash), 'PLANNED_CHANGES_MISMATCH');
        assert(contentApprovalHash(original.content) === contentApprovalHash(draft.content), 'CULINARY_CONTENT_CHANGED');
        if (publication) assert(contentApprovalHash(original.publication!.snapshot) === contentApprovalHash(publication.content), 'PUBLISHED_CULINARY_CONTENT_CHANGED');
        return { record, original, draft, publication };
      });
      if (mode[0] === '--preflight') return { mode: mode[0], productionMutation: false, planSha256, considered: rows.length, changedRecipes: changes.length,
        changedPublications: changes.filter(row => row.record.publicationId).length, rejectedCatalogRows: catalog.filter(row => row.eligibility !== 'rejected').length };
      const backup = option('--backup'); assert(backup, 'IMMUTABLE_BACKUP_REQUIRED');
      await writeFile(resolve(backup), JSON.stringify({ planSha256, recipes: rows, catalog, assets }, null, 2), { mode: 0o600, flag: 'wx' });
      if (changes.some(row => row.record.publicationId)) await invalidatePublicReadModel(tx);
      for (const { record, original, draft, publication } of changes) {
        const next = plan.after.find(row => row.id === original.id)!;
        if (record.publicationId) { const prior = original.publication!;
          await tx.execute(sql`INSERT INTO editorial_publication (id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name,reviewed_by,reviewed_by_name,reviewed_revision)
            VALUES (${record.publicationId},${original.id},${record.nextRevision},${JSON.stringify(publication!.content)}::jsonb,${record.nextPublicationHash},${JSON.stringify(prior.checks)}::jsonb,
            'manual',${actor.id},${actor.name},${prior.reviewed_by},${prior.reviewed_by_name},${prior.reviewed_revision})`); }
        const updated = await tx.execute(sql`UPDATE editorial_recipe SET content=${JSON.stringify(draft.content)}::jsonb,content_hash=${record.nextContentHash},revision=${record.nextRevision},
          checks_revision=${next.checks_revision},approved_revision=${next.approved_revision},published_id=${next.published_id},published_revision=${next.published_revision},
          updated_at=now(),updated_by=${actor.id},updated_by_name=${actor.name} WHERE id=${original.id} AND revision=${original.revision} AND content_hash=${original.content_hash} AND deleted_at IS NULL RETURNING id`);
        assert(updated.rows.length === 1, 'REVISION_CONFLICT');
        const reason = `${manifest.reason} Plan ${plan.planId}.`;
        await tx.execute(sql`INSERT INTO editorial_version (recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
          VALUES (${original.id},${record.nextRevision},${JSON.stringify(draft.content)}::jsonb,${record.nextContentHash},${reason},${actor.id},${actor.name})`);
        await tx.execute(sql`INSERT INTO editorial_audit (id,recipe_id,revision,action,actor_id,actor_name) VALUES (${record.auditId},${original.id},${record.nextRevision},${action},${actor.id},${actor.name})`);
        if (record.publicationId) await tx.execute(sql`INSERT INTO editorial_outbox (id,recipe_id,revision,event) VALUES (${record.outboxId},${original.id},${record.nextRevision},'publish')`);
      }
      for (const row of catalog.filter(row => row.eligibility !== 'rejected')) {
        const updated = await tx.execute(sql`UPDATE ingredient_image_catalog SET eligibility='rejected' WHERE key=${row.key} AND asset_id=${row.asset_id} AND eligibility=${row.eligibility} RETURNING key`);
        assert(updated.rows.length === 1, 'CATALOG_CONFLICT');
      }
      for (const audit of plan.quarantineAudits) await tx.execute(sql`INSERT INTO editorial_audit (id,recipe_id,revision,action,actor_id,actor_name)
        VALUES (${audit.id},${audit.recipeId},${audit.revision},${action},${actor.id},${actor.name})`);
      return { mode: mode[0], productionMutation: true, planSha256, changedRecipes: changes.length, changedPublications: changes.filter(row => row.record.publicationId).length,
        rejectedCatalogRows: catalog.filter(row => row.eligibility !== 'rejected').length, revisions: changes.map(({ record }) => ({ recipeId: record.recipeId, revision: record.nextRevision, publicationId: record.publicationId })) };
    }, { isolationLevel: 'serializable', accessMode: mode[0] === '--apply' ? 'read write' : 'read only' });
    console.log(JSON.stringify(result));
    if (mode[0] === '--apply' && result.changedPublications) console.log(JSON.stringify({ readModel: await refreshPublicReadModel() }));
  } finally { await closeDb(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(async error => {
  const diagnostic = option('--diagnostic');
  if (diagnostic) {
    let detail = JSON.stringify({ name: error instanceof Error ? error.name : 'Unknown', message: error instanceof Error ? error.message : 'Unknown',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : null, stack: error instanceof Error ? error.stack : null });
    for (const [key, value] of Object.entries(process.env)) if (value && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|DATABASE|POSTGRES/.test(key)) detail = detail.replaceAll(value, '[REDACTED]');
    await writeFile(resolve(diagnostic), detail, { mode: 0o600, flag: 'wx' });
  }
  const code = error instanceof Error ? error.message : 'UNKNOWN'; console.error('INGREDIENT_PHOTO_REPAIR_FAILED', /^[A-Z0-9_]+(?::[A-Za-z0-9_-]+)?$/.test(code) ? code : 'PRIVATE_DIAGNOSTIC_REQUIRED'); process.exitCode = 1;
});
