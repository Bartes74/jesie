import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import type { EditorialContent, ReviewChecks } from '../src/lib/editorial-types';
import type { MediaTile } from '../src/lib/recipe-media';
import { lemonIngredientPhotoForm, lemonPhotoSources, type LemonPhotoForm } from '../src/lib/citrus-photo-policy';

type Publication = { id: string; recipe_id: string; revision: number; snapshot: EditorialContent; content_hash: string; checks: ReviewChecks;
  approval_origin: string; published_by: string; published_by_name: string; reviewed_by: string | null; reviewed_by_name: string | null; reviewed_revision: number | null };
export type CitrusRepairRecipe = { id: string; revision: number; content: EditorialContent; content_hash: string; editorial_status: string;
  publication_status: string; checks: ReviewChecks; checks_revision: number; approved_revision: number | null; published_id: string | null;
  published_revision: number | null; deleted_at: Date | string | null; publication: Publication | null };
type Owner = { id: string; name: string };
type Asset = { form: LemonPhotoForm; src: string; sha256: string; bytes: number; width: number; height: number };
export type CitrusPhotoChange = { ingredientId: string; form: LemonPhotoForm; before: MediaTile | null; after: MediaTile };
type State = Omit<CitrusRepairRecipe, 'content' | 'publication' | 'deleted_at'> & { publication: Omit<Publication, 'snapshot'> | null };
type RepairRecord = { recipeId: string; title: string; nextRevision: number; draft: CitrusPhotoChange[]; publication: CitrusPhotoChange[];
  nextContentHash: string; nextPublicationHash: string | null; publicationId: string | null; auditId: string; outboxId: string | null };
export type CitrusRepairPlan = { version: 1; planId: string; createdAt: string; databaseScope: string; actor: Owner; assets: Asset[];
  before: State[]; after: State[]; records: RepairRecord[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const citrusRepairHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function invariant(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }

/** Only ingredient photo tiles change; whole lemons and all cooking text stay intact. */
export function repairCitrusPhotos(content: EditorialContent): { content: EditorialContent; changes: CitrusPhotoChange[] } {
  const next = structuredClone(content), changes: CitrusPhotoChange[] = [];
  for (const ingredient of content.recipe.ingredients) {
    const form = lemonIngredientPhotoForm(ingredient);
    invariant(form !== 'conflict', `CITRUS_FORM_CONFLICT:${ingredient.id}`);
    if (!form) continue;
    const before = content.photos.ingredients[ingredient.id] ?? null;
    const after: MediaTile = { ...(before ?? {}), src: lemonPhotoSources[form], columns: 1, rows: 1, index: 0, aspectRatio: 1,
      alt: structuredClone(ingredient.name) };
    if (same(before, after)) continue;
    next.photos.ingredients[ingredient.id] = after;
    changes.push({ ingredientId: ingredient.id, form, before: structuredClone(before), after });
  }
  return { content: next, changes };
}

export function citrusRepairInventory(recipes: readonly CitrusRepairRecipe[]): State[] {
  return recipes.filter(row => !row.deleted_at).map(row => {
    invariant(row.content_hash === citrusRepairHash(row.content), `CONTENT_HASH_MISMATCH:${row.id}`);
    const active = row.publication_status === 'published' ? row.publication : null;
    if (active) invariant(active.recipe_id === row.id && active.id === row.published_id && active.revision === row.published_revision
      && active.content_hash === citrusRepairHash(active.snapshot), `PUBLICATION_HASH_MISMATCH:${row.id}`);
    invariant(row.publication_status !== 'published' || active, `ACTIVE_PUBLICATION_MISSING:${row.id}`);
    const publicState = active ? { id: active.id, recipe_id: active.recipe_id, revision: active.revision, content_hash: active.content_hash,
      checks: active.checks, approval_origin: active.approval_origin, published_by: active.published_by, published_by_name: active.published_by_name,
      reviewed_by: active.reviewed_by, reviewed_by_name: active.reviewed_by_name, reviewed_revision: active.reviewed_revision } : null;
    return { id: row.id, revision: row.revision, content_hash: row.content_hash, editorial_status: row.editorial_status,
      publication_status: row.publication_status, checks: row.checks, checks_revision: row.checks_revision,
      approved_revision: row.approved_revision, published_id: row.published_id, published_revision: row.published_revision, publication: publicState };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function buildCitrusRepairPlan(recipes: readonly CitrusRepairRecipe[], context: { actor: Owner; databaseScope: string; assets: Asset[] }): CitrusRepairPlan {
  const active = recipes.filter(row => !row.deleted_at), before = citrusRepairInventory(active), after = structuredClone(before), records: RepairRecord[] = [];
  for (const row of active) {
    const draft = repairCitrusPhotos(row.content);
    const publication = row.publication_status === 'published' && row.publication ? repairCitrusPhotos(row.publication.snapshot) : null;
    if (!draft.changes.length && !publication?.changes.length) continue;
    const nextRevision = row.revision + 1;
    const publicationId = publication?.changes.length ? randomUUID() : null;
    const record: RepairRecord = { recipeId: row.id, title: row.content.recipe.title.pl, nextRevision, draft: draft.changes,
      publication: publication?.changes ?? [], nextContentHash: citrusRepairHash(draft.content),
      nextPublicationHash: publicationId ? citrusRepairHash(publication!.content) : null,
      publicationId, auditId: randomUUID(), outboxId: publicationId ? randomUUID() : null };
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
  return { version: 1, planId: randomUUID(), createdAt: new Date().toISOString(), ...context, before, after, records };
}

export type RecipePhotoRepairPlanState = { actor: Owner; before: State[]; after: State[]; records: {
  recipeId: string; nextRevision: number; draft: readonly unknown[]; publication: readonly unknown[];
  nextContentHash: string; nextPublicationHash: string | null; publicationId: string | null;
}[] };
/** Shared exact revision, review-state and independent-publication fences. */
export function recipePhotoRepairPlanState(plan: RecipePhotoRepairPlanState, recipes: readonly CitrusRepairRecipe[]): 'before' | 'after' {
  const predicted = structuredClone(plan.before), seen = new Set<string>();
  for (const record of plan.records) {
    const expected = predicted.find(row => row.id === record.recipeId);
    invariant(expected && !seen.has(record.recipeId) && record.nextRevision === expected.revision + 1
      && record.draft.length + record.publication.length > 0, 'PLANNED_RECORD_INVALID');
    seen.add(record.recipeId);
    const previousRevision = expected.revision;
    expected.revision = record.nextRevision; expected.content_hash = record.nextContentHash;
    if (expected.checks_revision === previousRevision) expected.checks_revision = record.nextRevision;
    if (expected.approved_revision === previousRevision) expected.approved_revision = record.nextRevision;
    invariant(Boolean(record.publicationId) === Boolean(record.publication.length), 'PLANNED_PUBLICATION_INVALID');
    if (record.publicationId) {
      invariant(expected.publication_status === 'published' && expected.publication && record.nextPublicationHash, 'PLANNED_PUBLICATION_INVALID');
      expected.published_id = record.publicationId; expected.published_revision = record.nextRevision;
      expected.publication = { ...expected.publication, id: record.publicationId, revision: record.nextRevision,
        content_hash: record.nextPublicationHash, approval_origin: 'manual', published_by: plan.actor.id, published_by_name: plan.actor.name };
    }
  }
  invariant(same(predicted, plan.after), 'PLANNED_AFTER_STATE_MISMATCH');
  const inventory = citrusRepairInventory(recipes);
  if (same(inventory, plan.before)) return 'before';
  if (same(inventory, plan.after)) return 'after';
  throw new Error('INVENTORY_CHANGED');
}
/** A repeated application is accepted only at the exact planned after state. */
export function citrusRepairPlanState(plan: CitrusRepairPlan, recipes: readonly CitrusRepairRecipe[]): 'before' | 'after' {
  return recipePhotoRepairPlanState(plan, recipes);
}

const option = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
async function assets(): Promise<Asset[]> {
  const result: Asset[] = [];
  for (const form of ['juice', 'zest'] as const) {
    const src = lemonPhotoSources[form], bytes = await readFile(resolve(`public${src}`));
    const metadata = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
    invariant(metadata.format === 'webp' && metadata.width && metadata.width === metadata.height && (metadata.pages ?? 1) === 1, 'CANONICAL_ASSET_INVALID');
    result.push({ form, src, sha256: sha(bytes), bytes: bytes.length, width: metadata.width, height: metadata.height });
  }
  invariant(result[0].sha256 !== result[1].sha256, 'CANONICAL_ASSETS_IDENTICAL');
  return result;
}

async function main() {
  const modes = ['--prepare', '--preflight', '--apply'].filter(mode => process.argv.includes(mode));
  invariant(modes.length === 1, 'CHOOSE_PREPARE_PREFLIGHT_OR_APPLY');
  const mode = modes[0], planPath = option('--plan'); invariant(planPath, 'PLAN_PATH_REQUIRED');
  config({ path: option('--env') ?? '.env.production.local', quiet: true });
  invariant(process.env.DATABASE_URL, 'DATABASE_REQUIRED');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const databaseScope = citrusRepairHash(`${databaseUrl.host}${databaseUrl.pathname}:${databaseUrl.username}`);
  databaseUrl.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = databaseUrl.href;
  const actualAssets = await assets();
  let plan: CitrusRepairPlan | undefined, planSha256: string | undefined;
  if (mode !== '--prepare') {
    const bytes = await readFile(resolve(planPath)); planSha256 = sha(bytes);
    invariant(option('--plan-sha256') === planSha256, 'EXACT_PLAN_SHA256_REQUIRED');
    plan = JSON.parse(bytes.toString()) as CitrusRepairPlan;
    invariant(plan.version === 1 && /^[a-f0-9-]{36}$/i.test(plan.planId) && plan.databaseScope === databaseScope, 'PLAN_SCOPE_INVALID');
    invariant(same(plan.assets, actualAssets), 'CANONICAL_ASSETS_CHANGED');
  }
  const { getDb, closeDb } = await import('../src/server/db');
  const { contentApprovalHash } = await import('../src/server/editorial/content-approval');
  const { invalidatePublicReadModel, refreshPublicReadModel } = await import('../src/server/public/read-model');
  try {
    const result = await getDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='10s'`);
      if (mode === '--apply') await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('repair-citrus-ingredient-photos-v1'))`);
      const owners = (await tx.execute(sql`SELECT id,name FROM auth_user WHERE role='owner' AND NOT disabled ORDER BY id`)).rows as Owner[];
      invariant(owners.length === 1, 'OWNER_AMBIGUOUS'); const actor = owners[0];
      const current = (await tx.execute(mode === '--apply'
        ? sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`
        : sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id`)).rows as Omit<CitrusRepairRecipe, 'publication'>[];
      const publications = (await tx.execute(sql`SELECT p.* FROM editorial_publication p JOIN editorial_recipe r ON r.published_id=p.id
        WHERE r.deleted_at IS NULL AND r.publication_status='published' ORDER BY p.id`)).rows as Publication[];
      const rows: CitrusRepairRecipe[] = current.map(row => ({ ...row, publication: publications.find(item => item.id === row.published_id) ?? null }));
      if (mode === '--prepare') {
        const prepared = buildCitrusRepairPlan(rows, { actor, assets: actualAssets, databaseScope });
        const bytes = Buffer.from(JSON.stringify(prepared, null, 2));
        await writeFile(resolve(planPath), bytes, { mode: 0o600, flag: 'wx' });
        return { mode, productionMutation: false, planSha256: sha(bytes), considered: rows.length,
          changedRecipes: prepared.records.length, changedPublications: prepared.records.filter(row => row.publicationId).length,
          changes: prepared.records.map(row => ({ recipeId: row.recipeId, title: row.title, nextRevision: row.nextRevision,
            draftTiles: row.draft.map(item => ({ ingredientId: item.ingredientId, form: item.form, src: item.after.src })),
            publicationTiles: row.publication.length })) };
      }
      const reviewed = plan!;
      invariant(same(reviewed.actor, actor), 'OWNER_CHANGED');
      const state = citrusRepairPlanState(reviewed, rows);
      const action = `repair_citrus_ingredient_photos:${reviewed.planId}`;
      const receipts = (await tx.execute(sql`SELECT id,recipe_id,revision FROM editorial_audit WHERE action=${action} ORDER BY recipe_id`)).rows;
      if (state === 'after') {
        invariant(same(receipts.map(row => ({ id: row.id, recipeId: row.recipe_id, revision: row.revision })), reviewed.records
          .map(row => ({ id: row.auditId, recipeId: row.recipeId, revision: row.nextRevision })).sort((a, b) => a.recipeId.localeCompare(b.recipeId))), 'APPLIED_RECEIPTS_MISSING');
        return { mode, productionMutation: false, alreadyApplied: true, planSha256, changedRecipes: reviewed.records.length,
          changedPublications: reviewed.records.filter(row => row.publicationId).length };
      }
      invariant(receipts.length === 0, 'PARTIAL_APPLICATION_RECEIPT');
      const changes = reviewed.records.map(record => {
        const original = rows.find(row => row.id === record.recipeId); invariant(original, 'PLANNED_RECIPE_MISSING');
        const draft = repairCitrusPhotos(original.content), publication = original.publication_status === 'published' && original.publication
          ? repairCitrusPhotos(original.publication.snapshot) : null;
        invariant(record.nextRevision === original.revision + 1 && same(draft.changes, record.draft)
          && same(publication?.changes ?? [], record.publication) && citrusRepairHash(draft.content) === record.nextContentHash
          && (!record.publicationId || publication && citrusRepairHash(publication.content) === record.nextPublicationHash), 'PLANNED_CHANGE_MISMATCH');
        invariant(Boolean(record.publicationId) === Boolean(publication?.changes.length), 'PUBLICATION_SCOPE_CHANGED');
        invariant(contentApprovalHash(original.content) === contentApprovalHash(draft.content), 'CULINARY_CONTENT_CHANGED');
        if (publication) invariant(contentApprovalHash(original.publication!.snapshot) === contentApprovalHash(publication.content), 'PUBLISHED_CULINARY_CONTENT_CHANGED');
        return { record, original, draft, publication };
      });
      if (mode === '--preflight') return { mode, productionMutation: false, planSha256, considered: rows.length,
        changedRecipes: changes.length, changedPublications: changes.filter(row => row.record.publicationId).length };
      const backupPath = option('--backup'); invariant(backupPath, 'IMMUTABLE_BACKUP_PATH_REQUIRED');
      await writeFile(resolve(backupPath), JSON.stringify({ planSha256, recipes: rows }, null, 2), { mode: 0o600, flag: 'wx' });
      if (changes.some(row => row.record.publicationId)) await invalidatePublicReadModel(tx);
      for (const { record, original, draft, publication } of changes) {
        const nextState = reviewed.after.find(row => row.id === original.id)!;
        if (record.publicationId) {
          const previous = original.publication!;
          await tx.execute(sql`INSERT INTO editorial_publication (id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,
            published_by,published_by_name,reviewed_by,reviewed_by_name,reviewed_revision)
            VALUES (${record.publicationId},${original.id},${record.nextRevision},${JSON.stringify(publication!.content)}::jsonb,${record.nextPublicationHash},
            ${JSON.stringify(previous.checks)}::jsonb,'manual',${actor.id},${actor.name},${previous.reviewed_by},${previous.reviewed_by_name},${previous.reviewed_revision})`);
        }
        const updated = await tx.execute(sql`UPDATE editorial_recipe SET content=${JSON.stringify(draft.content)}::jsonb,content_hash=${record.nextContentHash},
          revision=${record.nextRevision},checks_revision=${nextState.checks_revision},approved_revision=${nextState.approved_revision},
          published_id=${nextState.published_id},published_revision=${nextState.published_revision},updated_at=now(),updated_by=${actor.id},updated_by_name=${actor.name}
          WHERE id=${original.id} AND revision=${original.revision} AND content_hash=${original.content_hash} AND deleted_at IS NULL RETURNING id`);
        invariant(updated.rows.length === 1, 'REVISION_CONFLICT');
        const reason = `Korekta wyłącznie zdjęć soku i skórki cytrynowej na zlecenie właściciela; zachowano treść, status i akceptacje. Plan ${reviewed.planId}.`;
        await tx.execute(sql`INSERT INTO editorial_version (recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
          VALUES (${original.id},${record.nextRevision},${JSON.stringify(draft.content)}::jsonb,${record.nextContentHash},${reason},${actor.id},${actor.name})`);
        await tx.execute(sql`INSERT INTO editorial_audit (id,recipe_id,revision,action,actor_id,actor_name)
          VALUES (${record.auditId},${original.id},${record.nextRevision},${action},${actor.id},${actor.name})`);
        if (record.publicationId) await tx.execute(sql`INSERT INTO editorial_outbox (id,recipe_id,revision,event)
          VALUES (${record.outboxId},${original.id},${record.nextRevision},'publish')`);
      }
      return { mode, productionMutation: true, planSha256, changedRecipes: changes.length,
        changedPublications: changes.filter(row => row.record.publicationId).length,
        revisions: changes.map(({ record }) => ({ recipeId: record.recipeId, revision: record.nextRevision, publicationId: record.publicationId })) };
    }, { isolationLevel: 'serializable', accessMode: mode === '--apply' ? 'read write' : 'read only' });
    console.log(JSON.stringify(result));
    if (mode === '--apply' && result.changedPublications) console.log(JSON.stringify({ readModel: await refreshPublicReadModel() }));
  } finally { await closeDb(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  const code = error instanceof Error ? error.message : 'UNKNOWN';
  console.error('CITRUS_PHOTO_REPAIR_FAILED', /^[A-Z0-9_]+(?::[A-Za-z0-9_-]+)?$/.test(code) ? code : 'PRIVATE_DIAGNOSTIC_REQUIRED');
  process.exitCode = 1;
});
