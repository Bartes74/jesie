import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EditorialContent } from '../src/lib/editorial-types';
import { inspectRecipeDiet, recipeDietBaseNotes } from '../src/lib/recipe-diet';
import { ingredientIdentityParts, ingredientPhotoSemanticIdentity } from '../src/lib/ingredient-photo-identity';
import { citrusRepairHash as hash, citrusRepairInventory as inventory, type CitrusRepairRecipe as StoredRecipe } from './repair-citrus-ingredient-photos';

const localised = z.object({ pl: z.string().max(20_000), en: z.string().max(20_000) }).strict();
const correction = z.object({ recipeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), ingredientId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  scope: z.enum(['draft', 'publication']), beforeNote: localised.nullable(), afterNote: localised, reason: z.string().min(20).max(5000) }).strict();
const manifestSchema = z.object({ version: z.literal(1), reason: z.string().min(20).max(2000), corrections: z.array(correction).max(500) }).passthrough();
export type DietManifest = z.infer<typeof manifestSchema>;
type Scope = 'draft' | 'publication';
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function assert(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function appendedNote(before: string | undefined, extra: string): string {
  return `${before ?? ''}${before ? /[.!?]$/.test(before) ? ' ' : '. ' : ''}${extra}`;
}

/** The allowlist is additive and exact; arbitrary culinary edits cannot hide in the manifest. */
export function validateDietManifest(value: unknown): asserts value is DietManifest {
  assert(manifestSchema.safeParse(value).success, 'DIET_MANIFEST_INVALID');
  const seen = new Set<string>();
  for (const rule of (value as DietManifest).corrections) {
    const key = `${rule.scope}:${rule.recipeId}:${rule.ingredientId}`;
    assert(!seen.has(key), 'DIET_NOTE_RULE_OVERLAP'); seen.add(key);
    assert(Object.values(recipeDietBaseNotes).some(note => (['pl', 'en'] as const).every(locale =>
      rule.afterNote[locale] === appendedNote(rule.beforeNote?.[locale], note[locale]))), 'DIET_NOTE_NOT_ADDITIVE');
  }
}

/** Only the exclusive diet and the exact reviewed product-selection notes may change. */
export function patchRecipeDiet(content: EditorialContent, scope: Scope, manifest: DietManifest) {
  const next = structuredClone(content);
  const rules = manifest.corrections.filter(rule => rule.recipeId === content.recipe.id && rule.scope === scope);
  for (const rule of rules) {
    const ingredient = next.recipe.ingredients.find(item => item.id === rule.ingredientId);
    assert(ingredient, 'DIET_INGREDIENT_MISSING');
    assert(same(ingredient.note ?? null, rule.beforeNote), 'DIET_NOTE_CHANGED');
    const previous = structuredClone(ingredient); ingredient.note = structuredClone(rule.afterNote);
    assert(same(ingredientIdentityParts(previous), ingredientIdentityParts(ingredient))
      && same(ingredientPhotoSemanticIdentity(previous), ingredientPhotoSemanticIdentity(ingredient)), 'DIET_PHOTO_IDENTITY_CHANGED');
  }
  const inspection = inspectRecipeDiet({ ingredients: next.recipe.ingredients });
  assert(inspection.inferredDiet !== null, 'DIET_INGREDIENT_REVIEW_REQUIRED');
  next.recipe.diet = inspection.inferredDiet;
  return { content: next, changed: !same(content, next), notesChanged: rules.length > 0 };
}

type History = { versions: { key: string; row_hash: string }[]; publications: { key: string; row_hash: string }[]; approvals: { key: string; row_hash: string }[] };
type DietRecord = { recipeId: string; nextRevision: number; draftChanged: boolean; publicationChanged: boolean; draftNotesChanged: boolean; publicationNotesChanged: boolean;
  beforeDraft: EditorialContent; afterDraft: EditorialContent; beforePublication: EditorialContent | null; afterPublication: EditorialContent | null;
  publicationId: string | null; auditId: string; outboxId: string | null };
export type DietPlan = { version: 1; planId: string; databaseScope: string; createdAt: string; actor: { id: string; name: string }; manifest: DietManifest;
  before: ReturnType<typeof inventory>; after: ReturnType<typeof inventory>; records: DietRecord[]; history: History };

function projectRecord(states: DietPlan['after'], record: DietRecord, actor: DietPlan['actor']) {
  const state = states.find(item => item.id === record.recipeId); assert(state, 'DIET_PLAN_RECIPE_MISSING');
  const priorRevision = state.revision;
  state.revision = record.nextRevision; state.content_hash = hash(record.afterDraft);
  if (record.draftNotesChanged) {
    state.editorial_status = 'in_review'; state.approved_revision = null; state.checks = { ...state.checks, quantities: false };
  } else if (state.approved_revision === priorRevision) state.approved_revision = record.nextRevision;
  if (state.checks_revision === priorRevision) state.checks_revision = record.nextRevision;
  if (record.publicationId) {
    assert(state.publication, 'DIET_PUBLICATION_MISSING');
    state.published_id = record.publicationId; state.published_revision = record.nextRevision;
    state.publication = { ...state.publication, id: record.publicationId, revision: record.nextRevision, content_hash: hash(record.afterPublication),
      checks: record.publicationNotesChanged ? { ...state.publication.checks, quantities: false } : state.publication.checks,
      approval_origin: 'manual', published_by: actor.id, published_by_name: actor.name,
      ...(record.publicationNotesChanged ? { reviewed_by: null, reviewed_by_name: null, reviewed_revision: null } : {}) };
  }
}

export function buildDietPlan(rows: StoredRecipe[], manifest: DietManifest, context: Pick<DietPlan, 'actor' | 'databaseScope' | 'history'>): DietPlan {
  validateDietManifest(manifest);
  for (const rule of manifest.corrections) {
    const row = rows.find(item => item.id === rule.recipeId); assert(row && !row.deleted_at, 'DIET_RECIPE_MISSING');
    assert(rule.scope === 'draft' || row.publication_status === 'published' && row.publication, 'DIET_PUBLICATION_MISSING');
  }
  const before = inventory(rows), after = structuredClone(before), records: DietRecord[] = [];
  for (const row of rows.filter(item => !item.deleted_at)) {
    const draft = patchRecipeDiet(row.content, 'draft', manifest);
    const publication = row.publication_status === 'published' && row.publication ? patchRecipeDiet(row.publication.snapshot, 'publication', manifest) : null;
    if (!draft.changed && !publication?.changed) continue;
    const nextRevision = row.revision + 1, publicationId = publication?.changed ? randomUUID() : null;
    records.push({ recipeId: row.id, nextRevision, draftChanged: draft.changed, publicationChanged: Boolean(publication?.changed),
      draftNotesChanged: draft.notesChanged, publicationNotesChanged: Boolean(publication?.notesChanged),
      beforeDraft: structuredClone(row.content), afterDraft: draft.content,
      beforePublication: structuredClone(row.publication?.snapshot ?? null), afterPublication: publication?.content ?? null,
      publicationId, auditId: randomUUID(), outboxId: publicationId ? randomUUID() : null });
    projectRecord(after, records[records.length - 1], context.actor);
  }
  return { version: 1, planId: randomUUID(), createdAt: new Date().toISOString(), ...context, manifest: structuredClone(manifest), before, after, records };
}

export function dietPlanState(plan: DietPlan, rows: StoredRecipe[]): 'before' | 'after' {
  validateDietManifest(plan.manifest);
  const projected = structuredClone(plan.before), coveredNotes: string[] = [];
  const receiptIds = new Set<string>(), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  for (const record of plan.records) {
    assert(Boolean(record.outboxId) === record.publicationChanged, 'DIET_OUTBOX_REQUIRED');
    for (const id of [record.auditId, record.outboxId, record.publicationId].filter((id): id is string => id !== null)) {
      assert(uuid.test(id) && !receiptIds.has(id), 'DIET_RECEIPT_ID_INVALID'); receiptIds.add(id);
    }
    const before = plan.before.find(row => row.id === record.recipeId); assert(before, 'DIET_PLAN_RECIPE_MISSING');
    const draft = patchRecipeDiet(record.beforeDraft, 'draft', plan.manifest);
    const publication = record.beforePublication ? patchRecipeDiet(record.beforePublication, 'publication', plan.manifest) : null;
    assert(hash(record.beforeDraft) === before.content_hash && same(draft.content, record.afterDraft) && draft.changed === record.draftChanged
      && draft.notesChanged === record.draftNotesChanged, 'DIET_PLAN_DRAFT_INVALID');
    assert(!before.publication || hash(record.beforePublication) === before.publication.content_hash, 'DIET_PLAN_PUBLICATION_BEFORE_INVALID');
    assert(same(publication?.content ?? null, record.afterPublication) && Boolean(publication?.changed) === record.publicationChanged
      && Boolean(publication?.notesChanged) === record.publicationNotesChanged && Boolean(record.publicationId) === record.publicationChanged, 'DIET_PLAN_PUBLICATION_INVALID');
    assert(record.draftChanged || record.publicationChanged, 'DIET_PLAN_EMPTY_RECORD');
    for (const rule of plan.manifest.corrections.filter(rule => rule.recipeId === record.recipeId)) coveredNotes.push(`${rule.scope}:${rule.recipeId}:${rule.ingredientId}`);
    const after = plan.after.find(row => row.id === record.recipeId);
    assert(after && after.content_hash === hash(record.afterDraft) && after.revision === before.revision + 1 && record.nextRevision === after.revision
      && (!record.publicationId || after.publication?.id === record.publicationId && after.publication.content_hash === hash(record.afterPublication)), 'DIET_PLAN_STATE_INVALID');
    projectRecord(projected, record, plan.actor);
  }
  assert(same(coveredNotes.sort(), plan.manifest.corrections.map(rule => `${rule.scope}:${rule.recipeId}:${rule.ingredientId}`).sort()), 'DIET_PLAN_NOTE_COVERAGE_INVALID');
  assert(same(projected, plan.after), 'DIET_PLAN_METADATA_INVALID');
  assert(plan.records.length > 0 && plan.records.length === new Set(plan.records.map(record => record.recipeId)).size, 'DIET_PLAN_RECORDS_INVALID');
  const current = inventory(rows);
  if (same(current, plan.before)) return 'before';
  if (same(current, plan.after)) return 'after';
  throw Error('DIET_REVISION_CONFLICT');
}

const option = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
async function main() {
  const modes = ['--prepare', '--preflight', '--apply'].filter(mode => process.argv.includes(mode)); assert(modes.length === 1, 'DIET_MODE_REQUIRED');
  const mode = modes[0], path = option('--plan'); assert(path, 'DIET_PLAN_PATH_REQUIRED');
  config({ path: option('--env') ?? '.env.production.local', quiet: true }); assert(process.env.DATABASE_URL, 'DATABASE_REQUIRED');
  const url = new URL(process.env.DATABASE_URL), databaseScope = hash(`${url.host}${url.pathname}:${url.username}`);
  url.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = url.href;
  let reviewed: DietPlan | undefined, planSha: string | undefined;
  if (mode !== '--prepare') {
    const bytes = await readFile(resolve(path)); planSha = sha(bytes); assert(option('--plan-sha256') === planSha, 'DIET_EXACT_PLAN_SHA_REQUIRED');
    reviewed = JSON.parse(bytes.toString()); assert(reviewed?.version === 1 && reviewed.databaseScope === databaseScope, 'DIET_PLAN_SCOPE_INVALID');
  }
  let manifest: DietManifest;
  if (reviewed) manifest = reviewed.manifest;
  else { const file = option('--manifest'); assert(file, 'DIET_MANIFEST_REQUIRED'); manifest = JSON.parse(await readFile(resolve(file), 'utf8')); }
  validateDietManifest(manifest);
  const { getDb, closeDb } = await import('../src/server/db');
  const { editorialContentSchema } = await import('../src/server/editorial/validation');
  const { verifiedPublicationIssues } = await import('../src/server/editorial/store');
  const { invalidatePublicReadModel, refreshPublicReadModel } = await import('../src/server/public/read-model');
  try {
    const result = await getDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='10s'`);
      if (mode === '--apply') await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('assign-reviewed-recipe-diets-v1'))`);
      const owners = (await tx.execute(sql`SELECT id,name FROM auth_user WHERE role='owner' AND NOT disabled ORDER BY id`)).rows as DietPlan['actor'][];
      assert(owners.length === 1, 'DIET_OWNER_AMBIGUOUS'); const actor = owners[0];
      const current = (await tx.execute(mode === '--apply' ? sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`
        : sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id`)).rows as Omit<StoredRecipe, 'publication'>[];
      const pubs = (await tx.execute(sql`SELECT p.* FROM editorial_publication p JOIN editorial_recipe r ON r.published_id=p.id WHERE r.deleted_at IS NULL AND r.publication_status='published' ORDER BY p.id`)).rows as NonNullable<StoredRecipe['publication']>[];
      const rows = current.map(row => ({ ...row, publication: pubs.find(p => p.id === row.published_id) ?? null }));
      const history: History = {
        versions: (await tx.execute(sql`SELECT v.recipe_id||':'||v.revision AS key,md5(to_jsonb(v)::text) AS row_hash FROM editorial_version v JOIN editorial_recipe r ON r.id=v.recipe_id WHERE r.deleted_at IS NULL ORDER BY v.recipe_id,v.revision`)).rows as History['versions'],
        publications: (await tx.execute(sql`SELECT p.id AS key,md5(to_jsonb(p)::text) AS row_hash FROM editorial_publication p JOIN editorial_recipe r ON r.id=p.recipe_id WHERE r.deleted_at IS NULL ORDER BY p.id`)).rows as History['publications'],
        approvals: (await tx.execute(sql`SELECT a.recipe_id||':'||a.content_hash||':'||a.origin AS key,md5(to_jsonb(a)::text) AS row_hash FROM editorial_content_approval a JOIN editorial_recipe r ON r.id=a.recipe_id WHERE r.deleted_at IS NULL ORDER BY a.recipe_id,a.content_hash,a.origin`)).rows as History['approvals'],
      };
      const plan = reviewed ?? buildDietPlan(rows, manifest, { actor, databaseScope, history });
      assert(same(actor, plan.actor), 'DIET_OWNER_CHANGED'); const state = dietPlanState(plan, rows);
      const action = `assign_recipe_diets:${plan.planId}`;
      const receipts = (await tx.execute(sql`SELECT id,recipe_id,revision FROM editorial_audit WHERE action=${action} ORDER BY recipe_id`)).rows;
      const expected = plan.records.map(record => ({ id: record.auditId, recipe_id: record.recipeId, revision: record.nextRevision })).sort((a, b) => a.recipe_id.localeCompare(b.recipe_id));
      const versionKeys = new Set(plan.records.map(record => `${record.recipeId}:${record.nextRevision}`));
      const publicationIds = new Set(plan.records.flatMap(record => record.publicationId ? [record.publicationId] : []));
      const prior = state === 'after' ? { ...history, versions: history.versions.filter(v => !versionKeys.has(v.key)), publications: history.publications.filter(p => !publicationIds.has(p.key)) } : history;
      assert(same(prior, plan.history), 'DIET_HISTORY_OR_APPROVAL_CHANGED');
      if (state === 'after') { assert(same(receipts, expected), 'DIET_RECEIPT_MISSING'); return { mode, productionMutation: false, alreadyApplied: true, planSha }; }
      assert(receipts.length === 0, 'DIET_PARTIAL_APPLICATION');
      for (const record of plan.records) {
        editorialContentSchema.parse(record.afterDraft); if (record.afterPublication) editorialContentSchema.parse(record.afterPublication);
        for (const [before, after, changed] of [[record.beforeDraft, record.afterDraft, record.draftNotesChanged],
          [record.beforePublication, record.afterPublication, record.publicationNotesChanged]] as const) {
          if (before && after && changed) assert(same(await verifiedPublicationIssues(before, tx), await verifiedPublicationIssues(after, tx)), 'DIET_PHOTO_OR_PUBLICATION_ISSUES_CHANGED');
        }
      }
      const summary = { changedRecipes: plan.records.length, changedPublications: publicationIds.size,
        noteChangedDrafts: plan.records.filter(record => record.draftNotesChanged).length,
        noteChangedPublications: plan.records.filter(record => record.publicationNotesChanged).length };
      if (mode === '--prepare') { const bytes = Buffer.from(JSON.stringify(plan, null, 2)); await writeFile(resolve(path), bytes, { flag: 'wx', mode: 0o600 }); return { mode, productionMutation: false, planSha: sha(bytes), ...summary }; }
      if (mode === '--preflight') return { mode, productionMutation: false, planSha, ...summary };
      const backup = option('--backup'); assert(backup, 'DIET_BACKUP_REQUIRED');
      await writeFile(resolve(backup), JSON.stringify({ planSha, rows, history }, null, 2), { flag: 'wx', mode: 0o600 });
      if (publicationIds.size) await invalidatePublicReadModel(tx);
      for (const record of plan.records) {
        const original = rows.find(row => row.id === record.recipeId)!, next = plan.after.find(row => row.id === record.recipeId)!;
        if (record.publicationId) {
          const publication = next.publication!;
          await tx.execute(sql`INSERT INTO editorial_publication (id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name,reviewed_by,reviewed_by_name,reviewed_revision)
            VALUES (${record.publicationId},${record.recipeId},${record.nextRevision},${JSON.stringify(record.afterPublication)}::jsonb,${publication.content_hash},${JSON.stringify(publication.checks)}::jsonb,${publication.approval_origin},${actor.id},${actor.name},${publication.reviewed_by},${publication.reviewed_by_name},${publication.reviewed_revision})`);
        }
        const updated = await tx.execute(sql`UPDATE editorial_recipe SET content=${JSON.stringify(record.afterDraft)}::jsonb,content_hash=${next.content_hash},revision=${record.nextRevision},
          editorial_status=${next.editorial_status},checks=${JSON.stringify(next.checks)}::jsonb,checks_revision=${next.checks_revision},approved_revision=${next.approved_revision},
          published_id=${next.published_id},published_revision=${next.published_revision},updated_at=now(),updated_by=${actor.id},updated_by_name=${actor.name}
          WHERE id=${record.recipeId} AND revision=${original.revision} AND content_hash=${original.content_hash} AND deleted_at IS NULL RETURNING id`);
        assert(updated.rows.length === 1, 'DIET_UPDATE_CONFLICT');
        await tx.execute(sql`INSERT INTO editorial_version (recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
          VALUES (${record.recipeId},${record.nextRevision},${JSON.stringify(record.afterDraft)}::jsonb,${next.content_hash},${`${manifest.reason} Plan ${plan.planId}.`},${actor.id},${actor.name})`);
        await tx.execute(sql`INSERT INTO editorial_audit (id,recipe_id,revision,action,actor_id,actor_name) VALUES (${record.auditId},${record.recipeId},${record.nextRevision},${action},${actor.id},${actor.name})`);
        if (record.outboxId) await tx.execute(sql`INSERT INTO editorial_outbox (id,recipe_id,revision,event) VALUES (${record.outboxId},${record.recipeId},${record.nextRevision},'publish')`);
      }
      return { mode, productionMutation: true, planSha, ...summary };
    }, { isolationLevel: 'serializable', accessMode: mode === '--apply' ? 'read write' : 'read only' });
    console.log(JSON.stringify(result));
    if (mode === '--apply' && result.productionMutation) console.log(JSON.stringify({ readModel: await refreshPublicReadModel() }));
  } finally { await closeDb(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  const code = error instanceof Error ? error.message : ''; console.error('RECIPE_DIET_ASSIGNMENT_FAILED', /^[A-Z0-9_]+$/.test(code) ? code : 'PRIVATE_DIAGNOSTIC_REQUIRED'); process.exitCode = 1;
});
