import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EditorialContent } from '../src/lib/editorial-types';
import { citrusRepairHash as hash, citrusRepairInventory as inventory, type CitrusRepairRecipe as Recipe } from './repair-citrus-ingredient-photos';

// Exact reviewed corrections to existing recipes. Default operations are read-only.
// --prepare --manifest=file --plan=new-file, then --preflight/--apply with the
// exact --plan-sha256. Application requires a create-only --backup and preserves
// all previous publications, versions and manual approval receipts.
const timesSchema = z.object({ active: z.number().int().min(0).max(100_000), cooking: z.number().int().min(0).max(100_000),
  rest: z.number().int().min(0).max(100_000), total: z.number().int().positive().max(100_000) }).strict()
  .refine(t => t.total >= Math.max(t.active, t.cooking, t.rest));
const localised = z.object({ pl: z.string().min(1).max(20_000), en: z.string().min(1).max(20_000) }).strict();
const textEditSchema = z.object({ field: z.enum(['description', 'tip', 'seoDescription', 'seoTitle', 'seoAnswer']), index: z.number().int().min(0).max(99).optional(),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(), before: localised, after: localised }).strict()
  .refine(e => (e.field === 'tip') === (e.index !== undefined) && (e.field === 'seoAnswer') === (e.id !== undefined));
const keywords = z.object({ pl: z.array(z.string().max(500)).max(12), en: z.array(z.string().max(500)).max(12) }).strict();
const collections = z.array(z.enum(['quick-dinners', 'one-pot', 'pantry', 'seasonal'])).max(4);
const listEditSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('seoKeywords'), before: keywords, after: keywords }).strict(),
  z.object({ field: z.literal('seoCollectionIds'), before: collections, after: collections }).strict(),
]);
const ruleSchema = z.object({ recipeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), scope: z.enum(['draft', 'publication', 'both']),
  before: timesSchema, after: timesSchema, reason: z.string().trim().min(20).max(5000),
  textEdits: z.array(textEditSchema).max(20).optional(),
  listEdits: z.array(listEditSchema).max(2).optional(),
  note: z.object({ pl: z.string().trim().min(1).max(2000), en: z.string().trim().min(1).max(2000) }).strict().optional() }).strict();
const manifestSchema = z.object({ version: z.literal(1), reason: z.string().trim().min(20).max(2000), rules: z.array(ruleSchema).min(1).max(500) }).strict();
export type TimingManifest = z.infer<typeof manifestSchema>;
type Scope = 'draft' | 'publication';
const scopes = (s: TimingManifest['rules'][number]['scope']): Scope[] => s === 'both' ? ['draft', 'publication'] : [s];
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function assert(value: unknown, code: string): asserts value { if (!value) throw Error(code); }

export function validateTimingManifest(value: unknown): asserts value is TimingManifest {
  assert(manifestSchema.safeParse(value).success, 'TIMING_MANIFEST_INVALID');
  const seen = new Set<string>();
  for (const rule of (value as TimingManifest).rules) for (const scope of scopes(rule.scope)) {
    const key = `${rule.recipeId}:${scope}`; assert(!seen.has(key), 'TIMING_RULE_OVERLAP'); seen.add(key);
    assert(!same(rule.before, rule.after) || rule.note || rule.textEdits?.length || rule.listEdits?.length, 'TIMING_RULE_EMPTY');
    const edited = new Set<string>();
    for (const edit of rule.textEdits ?? []) { const key = `${edit.field}:${edit.index ?? edit.id ?? ''}`; assert(!edited.has(key), 'TIMING_PROSE_OVERLAP'); edited.add(key); }
    assert(new Set(rule.listEdits?.map(e => e.field)).size === (rule.listEdits?.length ?? 0), 'TIMING_LIST_OVERLAP');
  }
}

/** No method, timer, photo, ingredient or photo-omission signature can change. */
export function patchRecipeTimes(content: EditorialContent, scope: Scope, manifest: TimingManifest) {
  const next = structuredClone(content);
  const rule = manifest.rules.find(r => r.recipeId === content.recipe.id && scopes(r.scope).includes(scope));
  if (!rule) return { content: next, changed: false };
  assert(same(content.recipe.times, rule.before), 'TIMING_VALUES_CHANGED');
  next.recipe.times = structuredClone(rule.after);
  for (const edit of rule.textEdits ?? []) {
    const target = edit.field === 'description' ? next.recipe.description : edit.field === 'seoDescription' ? next.recipe.seo?.description
      : edit.field === 'seoTitle' ? next.recipe.seo?.title
      : edit.field === 'seoAnswer' ? next.recipe.seo?.questions?.find(q => q.id === edit.id)?.answer
        : { pl: next.recipe.tips.pl[edit.index!], en: next.recipe.tips.en[edit.index!] };
    assert(target && same(target, edit.before), 'TIMING_PROSE_CHANGED');
    if (edit.field === 'tip') for (const locale of ['pl', 'en'] as const) next.recipe.tips[locale][edit.index!] = edit.after[locale];
    else Object.assign(target, structuredClone(edit.after));
  }
  for (const edit of rule.listEdits ?? []) {
    const seo = next.recipe.seo; assert(seo, 'TIMING_SEO_MISSING');
    if (edit.field === 'seoKeywords') { assert(same(seo.keywords, edit.before), 'TIMING_SEO_LIST_CHANGED'); seo.keywords = structuredClone(edit.after); }
    else { assert(same(seo.collectionIds, edit.before), 'TIMING_SEO_LIST_CHANGED'); seo.collectionIds = structuredClone(edit.after); }
  }
  if (rule.note) for (const locale of ['pl', 'en'] as const) {
    assert(!next.recipe.tips[locale].includes(rule.note[locale]), 'TIMING_NOTE_ALREADY_PRESENT');
    next.recipe.tips[locale].push(rule.note[locale]);
  }
  return { content: next, changed: !same(content, next) };
}

type History = { versions: { key: string; row_hash: string }[]; publications: { key: string; row_hash: string }[]; approvals: { key: string; row_hash: string }[] };
type Record = { recipeId: string; nextRevision: number; draftChanged: boolean; publicationChanged: boolean;
  beforeDraft: EditorialContent; afterDraft: EditorialContent; beforePublication: EditorialContent | null; afterPublication: EditorialContent | null;
  publicationId: string | null; auditId: string; outboxId: string | null };
type Plan = { version: 1; planId: string; databaseScope: string; createdAt: string; actor: { id: string; name: string }; manifest: TimingManifest;
  before: ReturnType<typeof inventory>; after: ReturnType<typeof inventory>; records: Record[]; history: History };

function projectRecord(states: Plan['after'], record: Record, actor: Plan['actor']) {
  const state = states.find(item => item.id === record.recipeId); assert(state, 'TIMING_PLAN_RECIPE_MISSING');
  const priorRevision = state.revision;
  state.revision = record.nextRevision; state.content_hash = hash(record.afterDraft);
  // A correction requested by the owner authorises updating an existing release,
  // but does not create a human review of the edited culinary content.
  if (record.draftChanged) { state.editorial_status = 'in_review'; state.approved_revision = null; state.checks = { ...state.checks, method: false }; }
  if (state.checks_revision === priorRevision) state.checks_revision = record.nextRevision;
  if (record.publicationId) {
    assert(state.publication, 'TIMING_PUBLICATION_MISSING');
    state.published_id = record.publicationId; state.published_revision = record.nextRevision;
    state.publication = { ...state.publication, id: record.publicationId, revision: record.nextRevision, content_hash: hash(record.afterPublication),
      checks: { ...state.publication.checks, method: false }, approval_origin: 'manual', published_by: actor.id, published_by_name: actor.name,
      reviewed_by: null, reviewed_by_name: null, reviewed_revision: null };
  }
}

export function buildTimingPlan(rows: Recipe[], manifest: TimingManifest, context: Pick<Plan, 'actor' | 'databaseScope' | 'history'>): Plan {
  validateTimingManifest(manifest);
  for (const rule of manifest.rules) {
    const row = rows.find(row => row.id === rule.recipeId); assert(row && !row.deleted_at, 'TIMING_RECIPE_MISSING');
    assert(rule.scope === 'draft' || row.publication_status === 'published' && row.publication, 'TIMING_PUBLICATION_MISSING');
  }
  const before = inventory(rows), after = structuredClone(before), records: Record[] = [];
  for (const row of rows) {
    const draft = patchRecipeTimes(row.content, 'draft', manifest);
    const publication = row.publication_status === 'published' && row.publication ? patchRecipeTimes(row.publication.snapshot, 'publication', manifest) : null;
    if (!draft.changed && !publication?.changed) continue;
    const nextRevision = row.revision + 1, publicationId = publication?.changed ? randomUUID() : null;
    records.push({ recipeId: row.id, nextRevision, draftChanged: draft.changed, publicationChanged: Boolean(publication?.changed), beforeDraft: structuredClone(row.content),
      afterDraft: draft.content, beforePublication: structuredClone(row.publication?.snapshot ?? null), afterPublication: publication?.content ?? null,
      publicationId, auditId: randomUUID(), outboxId: publicationId ? randomUUID() : null });
    projectRecord(after, records[records.length - 1], context.actor);
  }
  return { version: 1, planId: randomUUID(), createdAt: new Date().toISOString(), ...context, manifest: structuredClone(manifest), before, after, records };
}

export function timingPlanState(plan: Plan, rows: Recipe[]): 'before' | 'after' {
  validateTimingManifest(plan.manifest);
  const projected = structuredClone(plan.before), covered = new Set<string>();
  const receiptIds = new Set<string>(), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  for (const record of plan.records) {
    assert(Boolean(record.outboxId) === record.publicationChanged, 'TIMING_OUTBOX_REQUIRED');
    for (const id of [record.auditId, record.outboxId, record.publicationId].filter((id): id is string => id !== null)) {
      assert(uuid.test(id) && !receiptIds.has(id), 'TIMING_RECEIPT_ID_INVALID'); receiptIds.add(id);
    }
    const before = plan.before.find(row => row.id === record.recipeId); assert(before, 'TIMING_PLAN_RECIPE_MISSING');
    const draft = patchRecipeTimes(record.beforeDraft, 'draft', plan.manifest);
    const publication = record.beforePublication ? patchRecipeTimes(record.beforePublication, 'publication', plan.manifest) : null;
    assert(hash(record.beforeDraft) === before.content_hash && same(draft.content, record.afterDraft) && draft.changed === record.draftChanged,
      'TIMING_PLAN_DRAFT_INVALID');
    assert(!before.publication || hash(record.beforePublication) === before.publication.content_hash, 'TIMING_PLAN_PUBLICATION_BEFORE_INVALID');
    assert(same(publication?.content ?? null, record.afterPublication) && Boolean(publication?.changed) === record.publicationChanged
      && Boolean(record.publicationId) === record.publicationChanged, 'TIMING_PLAN_PUBLICATION_INVALID');
    assert(record.draftChanged || record.publicationChanged, 'TIMING_PLAN_EMPTY_RECORD');
    if (record.draftChanged) covered.add(`${record.recipeId}:draft`);
    if (record.publicationChanged) covered.add(`${record.recipeId}:publication`);
    const after = plan.after.find(row => row.id === record.recipeId); assert(after && after.content_hash === hash(record.afterDraft)
      && after.revision === before.revision + 1 && record.nextRevision === after.revision
      && (!record.publicationId || after.publication?.id === record.publicationId && after.publication.content_hash === hash(record.afterPublication)), 'TIMING_PLAN_STATE_INVALID');
    projectRecord(projected, record, plan.actor);
  }
  const required = plan.manifest.rules.flatMap(r => scopes(r.scope).map(s => `${r.recipeId}:${s}`)).sort();
  assert(same([...covered].sort(), required), 'TIMING_PLAN_COVERAGE_INVALID');
  assert(same(projected, plan.after), 'TIMING_PLAN_METADATA_INVALID');
  assert(plan.records.length > 0 && plan.records.length === new Set(plan.records.map(r => r.recipeId)).size, 'TIMING_PLAN_RECORDS_INVALID');
  const current = inventory(rows);
  if (same(current, plan.before)) return 'before';
  if (same(current, plan.after)) return 'after';
  throw Error('TIMING_REVISION_CONFLICT');
}

const option = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
async function main() {
  const modes = ['--prepare', '--preflight', '--apply'].filter(mode => process.argv.includes(mode)); assert(modes.length === 1, 'TIMING_MODE_REQUIRED');
  const mode = modes[0], path = option('--plan'); assert(path, 'TIMING_PLAN_PATH_REQUIRED');
  config({ path: option('--env') ?? '.env.production.local', quiet: true }); assert(process.env.DATABASE_URL, 'DATABASE_REQUIRED');
  const url = new URL(process.env.DATABASE_URL), databaseScope = hash(`${url.host}${url.pathname}:${url.username}`);
  url.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = url.href;
  let reviewed: Plan | undefined, planSha: string | undefined;
  if (mode !== '--prepare') {
    const bytes = await readFile(resolve(path)); planSha = sha(bytes); assert(option('--plan-sha256') === planSha, 'TIMING_EXACT_PLAN_SHA_REQUIRED');
    reviewed = JSON.parse(bytes.toString()); assert(reviewed?.version === 1 && reviewed.databaseScope === databaseScope, 'TIMING_PLAN_SCOPE_INVALID');
  }
  let manifest: TimingManifest;
  if (reviewed) manifest = reviewed.manifest;
  else { const p = option('--manifest'); assert(p, 'TIMING_MANIFEST_REQUIRED'); manifest = JSON.parse(await readFile(resolve(p), 'utf8')); }
  validateTimingManifest(manifest);
  const { getDb, closeDb } = await import('../src/server/db');
  const { editorialContentSchema } = await import('../src/server/editorial/validation');
  const { invalidatePublicReadModel, refreshPublicReadModel } = await import('../src/server/public/read-model');
  try {
    const result = await getDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='10s'`);
      if (mode === '--apply') await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('repair-reviewed-recipe-times-v1'))`);
      const owners = (await tx.execute(sql`SELECT id,name FROM auth_user WHERE role='owner' AND NOT disabled ORDER BY id`)).rows as Plan['actor'][];
      assert(owners.length === 1, 'TIMING_OWNER_AMBIGUOUS'); const actor = owners[0];
      const current = (await tx.execute(mode === '--apply' ? sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`
        : sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id`)).rows as Omit<Recipe, 'publication'>[];
      const pubs = (await tx.execute(sql`SELECT p.* FROM editorial_publication p JOIN editorial_recipe r ON r.published_id=p.id WHERE r.deleted_at IS NULL AND r.publication_status='published' ORDER BY p.id`)).rows as NonNullable<Recipe['publication']>[];
      const rows = current.map(row => ({ ...row, publication: pubs.find(p => p.id === row.published_id) ?? null }));
      const history: History = {
        versions: (await tx.execute(sql`SELECT v.recipe_id||':'||v.revision AS key,md5(to_jsonb(v)::text) AS row_hash FROM editorial_version v JOIN editorial_recipe r ON r.id=v.recipe_id WHERE r.deleted_at IS NULL ORDER BY v.recipe_id,v.revision`)).rows as History['versions'],
        publications: (await tx.execute(sql`SELECT p.id AS key,md5(to_jsonb(p)::text) AS row_hash FROM editorial_publication p JOIN editorial_recipe r ON r.id=p.recipe_id WHERE r.deleted_at IS NULL ORDER BY p.id`)).rows as History['publications'],
        approvals: (await tx.execute(sql`SELECT a.recipe_id||':'||a.content_hash||':'||a.origin AS key,md5(to_jsonb(a)::text) AS row_hash FROM editorial_content_approval a JOIN editorial_recipe r ON r.id=a.recipe_id WHERE r.deleted_at IS NULL ORDER BY a.recipe_id,a.content_hash,a.origin`)).rows as History['approvals'],
      };
      const plan = reviewed ?? buildTimingPlan(rows, manifest, { actor, databaseScope, history });
      assert(same(actor, plan.actor), 'TIMING_OWNER_CHANGED'); const state = timingPlanState(plan, rows);
      const action = `repair_recipe_times:${plan.planId}`;
      const receipts = (await tx.execute(sql`SELECT id,recipe_id,revision FROM editorial_audit WHERE action=${action} ORDER BY recipe_id`)).rows;
      const expected = plan.records.map(r => ({ id: r.auditId, recipe_id: r.recipeId, revision: r.nextRevision })).sort((a, b) => a.recipe_id.localeCompare(b.recipe_id));
      const versionKeys = new Set(plan.records.map(r => `${r.recipeId}:${r.nextRevision}`)), publicationIds = new Set(plan.records.flatMap(r => r.publicationId ? [r.publicationId] : []));
      const prior = state === 'after' ? { ...history, versions: history.versions.filter(v => !versionKeys.has(v.key)), publications: history.publications.filter(p => !publicationIds.has(p.key)) } : history;
      assert(same(prior, plan.history), 'TIMING_HISTORY_OR_APPROVAL_CHANGED');
      if (state === 'after') { assert(same(receipts, expected), 'TIMING_RECEIPT_MISSING'); return { mode, productionMutation: false, alreadyApplied: true, planSha }; }
      assert(receipts.length === 0, 'TIMING_PARTIAL_APPLICATION');
      for (const r of plan.records) { editorialContentSchema.parse(r.afterDraft); if (r.afterPublication) editorialContentSchema.parse(r.afterPublication); }
      const summary = { changedRecipes: plan.records.length, changedPublications: publicationIds.size };
      if (mode === '--prepare') { const bytes = Buffer.from(JSON.stringify(plan, null, 2)); await writeFile(resolve(path), bytes, { flag: 'wx', mode: 0o600 }); return { mode, productionMutation: false, planSha: sha(bytes), ...summary }; }
      if (mode === '--preflight') return { mode, productionMutation: false, planSha, ...summary };
      const backup = option('--backup'); assert(backup, 'TIMING_BACKUP_REQUIRED');
      await writeFile(resolve(backup), JSON.stringify({ planSha, rows, history }, null, 2), { flag: 'wx', mode: 0o600 });
      if (publicationIds.size) await invalidatePublicReadModel(tx);
      for (const r of plan.records) {
        const original = rows.find(row => row.id === r.recipeId)!, next = plan.after.find(row => row.id === r.recipeId)!;
        if (r.publicationId) {
          const p = next.publication!;
          await tx.execute(sql`INSERT INTO editorial_publication (id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name)
            VALUES (${r.publicationId},${r.recipeId},${r.nextRevision},${JSON.stringify(r.afterPublication)}::jsonb,${p.content_hash},${JSON.stringify(p.checks)}::jsonb,${p.approval_origin},${actor.id},${actor.name})`);
        }
        const updated = await tx.execute(sql`UPDATE editorial_recipe SET content=${JSON.stringify(r.afterDraft)}::jsonb,content_hash=${next.content_hash},revision=${r.nextRevision},
          editorial_status=${next.editorial_status},checks=${JSON.stringify(next.checks)}::jsonb,checks_revision=${next.checks_revision},approved_revision=${next.approved_revision},
          published_id=${next.published_id},published_revision=${next.published_revision},updated_at=now(),updated_by=${actor.id},updated_by_name=${actor.name}
          WHERE id=${r.recipeId} AND revision=${original.revision} AND content_hash=${original.content_hash} AND deleted_at IS NULL RETURNING id`);
        assert(updated.rows.length === 1, 'TIMING_UPDATE_CONFLICT');
        await tx.execute(sql`INSERT INTO editorial_version (recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
          VALUES (${r.recipeId},${r.nextRevision},${JSON.stringify(r.afterDraft)}::jsonb,${next.content_hash},${`${manifest.reason} Plan ${plan.planId}.`},${actor.id},${actor.name})`);
        await tx.execute(sql`INSERT INTO editorial_audit (id,recipe_id,revision,action,actor_id,actor_name) VALUES (${r.auditId},${r.recipeId},${r.nextRevision},${action},${actor.id},${actor.name})`);
        if (r.outboxId) await tx.execute(sql`INSERT INTO editorial_outbox (id,recipe_id,revision,event) VALUES (${r.outboxId},${r.recipeId},${r.nextRevision},'publish')`);
      }
      return { mode, productionMutation: true, planSha, ...summary };
    }, { isolationLevel: 'serializable', accessMode: mode === '--apply' ? 'read write' : 'read only' });
    console.log(JSON.stringify(result));
    if (mode === '--apply' && result.productionMutation) console.log(JSON.stringify({ readModel: await refreshPublicReadModel() }));
  } finally { await closeDb(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  const code = error instanceof Error ? error.message : ''; console.error('RECIPE_TIMING_REPAIR_FAILED', /^[A-Z0-9_]+$/.test(code) ? code : 'PRIVATE_DIAGNOSTIC_REQUIRED'); process.exitCode = 1;
});
