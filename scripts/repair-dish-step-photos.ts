import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { z } from 'zod';
import type { EditorialContent, StepPhotoOmission } from '../src/lib/editorial-types';
import type { MediaTile } from '../src/lib/recipe-media';
import { stepPhotoSignature, validStepPhotoOmission } from '../src/lib/step-photo-selection';
import { recipePhotoAssignmentIssues } from '../src/lib/recipe-photo-evidence';
import { isGlassHeroPresentation, resolveHeroPresentation } from '../src/lib/hero-presentation';
import { citrusRepairHash as hash, citrusRepairInventory as inventory, recipePhotoRepairPlanState,
  type CitrusRepairRecipe as Recipe, type RecipePhotoRepairPlanState } from './repair-citrus-ingredient-photos';

// Run with NODE_OPTIONS=--conditions=react-server.
// --manifest=review.json --plan=new-plan.json prepares a create-only private plan.
// --plan=plan.json --plan-sha256=SHA defaults to a read-only preflight.
// Only --apply with the exact plan SHA and --backup=new-backup.json can write.
// assetChecks pin already-prepared static normalizations; this operator never
// edits image bytes, generates assets, or rewrites historical versions.
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function assert(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeSource = (src: string) => /^\/images\/[A-Za-z0-9_./-]+\.(?:webp|png|jpe?g)$/.test(src) && !src.includes('..')
  || src.startsWith('/media/') && uuid.test(src.slice(7));
const localised = z.object({ pl: z.string().max(20_000), en: z.string().max(20_000) }).strict();
const visibleText = localised.refine(value => value.pl.trim() && value.en.trim());
const tile = z.object({ src: z.string().max(2000), columns: z.number().int().min(1).max(20), rows: z.number().int().min(1).max(20),
  index: z.number().int().min(0).max(399), alt: localised, caption: localised.optional(), aspectRatio: z.number().positive().max(20).optional() }).strict()
  .refine(value => value.index < value.columns * value.rows && safeSource(value.src));
const omission = z.object({ signature: z.string().regex(/^[a-f0-9]{16}$/), reason: visibleText }).strict();
const hero = z.object({ src: z.string().max(2000), alt: localised }).strict();
const stepEdit = z.object({ stepId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), signature: z.string().regex(/^[a-f0-9]{16}$/),
  before: tile.nullable(), after: tile.nullable(), beforeOmission: omission.nullable(), afterOmission: omission.nullable(),
  review: z.string().trim().min(1).max(4000) }).strict();
const ruleSchema = z.object({ recipeId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), scope: z.enum(['draft', 'publication', 'both']),
  review: z.string().trim().min(1).max(4000), hero: z.object({ before: hero, after: hero }).strict().optional(),
  steps: z.array(stepEdit).max(100).optional() }).strict();
const assetCheckSchema = z.object({ src: z.string().max(2000).refine(safeSource), kind: z.enum(['hero', 'step']),
  recipeId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), targetId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), review: z.string().trim().min(1).max(4000) }).strict();
const manifestSchema = z.object({ version: z.literal(1), reason: z.string().trim().min(1).max(2000),
  rules: z.array(ruleSchema).max(2000), assetChecks: z.array(assetCheckSchema).max(2000).optional() }).strict();
export type DishStepPhotoRepairManifest = z.infer<typeof manifestSchema>;
export type DishStepPhotoRepairRule = z.infer<typeof ruleSchema>;
type Scope = 'draft' | 'publication';
export type DishStepChange = { kind: 'hero'; before: { src: string; alt: { pl: string; en: string } }; after: { src: string; alt: { pl: string; en: string } }; review: string }
  | { kind: 'step'; stepId: string; signature: string; before: MediaTile | null; after: MediaTile | null;
    beforeOmission: StepPhotoOmission | null; afterOmission: StepPhotoOmission | null; review: string };
type Owner = { id: string; name: string };
type Asset = { id: string; recipe_id: string; job_id: string; kind: string; target_id: string | null; blob_pathname: string;
  original_blob_pathname: string | null; width: number; height: number; source_recipe_id: string; source_kind: string;
  source_target_id: string | null; source_status: string; result_asset_id: string | null };
type Proof = { src: string; sha256: string; bytes: number; width: number; height: number; asset: Asset | null };
type HistoryRow = { recipe_id: string; key: string; content_hash: string; row_hash: string };
type History = { versions: HistoryRow[]; publications: HistoryRow[]; approvals: { key: string; row_hash: string }[] };
type Record = { recipeId: string; title: string; nextRevision: number; draft: DishStepChange[]; publication: DishStepChange[];
  beforeDraft: EditorialContent; afterDraft: EditorialContent; beforePublication: EditorialContent | null; afterPublication: EditorialContent | null;
  nextContentHash: string; nextPublicationHash: string | null; publicationId: string | null; auditId: string; outboxId: string | null };
export type DishStepPhotoRepairPlan = Omit<RecipePhotoRepairPlanState, 'records'> & { version: 1; planId: string; createdAt: string; databaseScope: string;
  manifest: DishStepPhotoRepairManifest; manifestSha256: string; proofs: Proof[]; records: Record[]; historyBefore: History };
const scopes = (scope: DishStepPhotoRepairRule['scope']): Scope[] => scope === 'both' ? ['draft', 'publication'] : [scope];

export function validateDishStepPhotoRepairManifest(value: unknown): asserts value is DishStepPhotoRepairManifest {
  assert(manifestSchema.safeParse(value).success, 'MANIFEST_INVALID');
  const manifest = value as DishStepPhotoRepairManifest;
  assert(manifest.rules.length + (manifest.assetChecks?.length ?? 0) > 0, 'MANIFEST_EMPTY');
  const seen = new Set<string>();
  for (const rule of manifest.rules) {
    assert(rule.hero || rule.steps?.length, 'RULE_EMPTY');
    if (rule.hero) assert(safeSource(rule.hero.after.src) && rule.hero.after.alt.pl.trim() && rule.hero.after.alt.en.trim(), 'HERO_REPLACEMENT_INVALID');
    for (const step of rule.steps ?? []) {
      assert(!step.after || step.after.columns === 1 && step.after.rows === 1 && step.after.index === 0
        && step.after.alt.pl.trim() && step.after.alt.en.trim()
        && (step.after.aspectRatio === undefined || Math.abs(step.after.aspectRatio - 21 / 9) < 1e-9), 'STEP_REPLACEMENT_INVALID');
      assert(!step.after || !step.afterOmission, 'PHOTO_AND_OMISSION_CONFLICT');
      assert(step.after || step.afterOmission, 'EXPLICIT_REMOVAL_REVIEW_REQUIRED');
    }
    for (const scope of scopes(rule.scope)) for (const target of [...(rule.hero ? ['hero'] : []), ...(rule.steps ?? []).map(step => `step:${step.stepId}`)]) {
      const key = JSON.stringify([rule.recipeId, scope, target]); assert(!seen.has(key), 'OVERLAPPING_RULES'); seen.add(key);
    }
  }
  for (const check of manifest.assetChecks ?? []) assert((check.kind === 'hero') === (check.targetId === null), 'ASSET_CHECK_TARGET_INVALID');
}

/** Only exact reviewed hero fields, step tiles and their matching omission records may change. */
export function patchReviewedDishStepPhotos(content: EditorialContent, recipeId: string, scope: Scope, manifest: DishStepPhotoRepairManifest) {
  assert(content.recipe.id === recipeId, 'CONTENT_RECIPE_MISMATCH');
  const next = structuredClone(content), changes: DishStepChange[] = [];
  for (const rule of manifest.rules.filter(rule => rule.recipeId === recipeId && scopes(rule.scope).includes(scope))) {
    if (rule.hero) {
      const before = { src: content.recipe.image, alt: content.recipe.imageAlt };
      assert(same(before, rule.hero.before), 'HERO_CHANGED');
      if (!same(before, rule.hero.after)) {
        next.recipe.image = rule.hero.after.src; next.recipe.imageAlt = structuredClone(rule.hero.after.alt);
        changes.push({ kind: 'hero', before: structuredClone(before), after: structuredClone(rule.hero.after), review: rule.review });
      }
    }
    for (const edit of rule.steps ?? []) {
      const step = content.recipe.steps.find(step => step.id === edit.stepId);
      assert(step && stepPhotoSignature(step) === edit.signature, `STEP_CHANGED:${edit.stepId}`);
      const before = content.photos.steps[edit.stepId] ?? null, beforeOmission = content.photos.omittedSteps?.[edit.stepId] ?? null;
      assert(same(before, edit.before) && same(beforeOmission, edit.beforeOmission), `STEP_PHOTO_CHANGED:${edit.stepId}`);
      assert(!edit.afterOmission || edit.afterOmission.signature === stepPhotoSignature(step), `OMISSION_SIGNATURE_INVALID:${edit.stepId}`);
      if (same(before, edit.after) && same(beforeOmission, edit.afterOmission)) continue;
      if (edit.after) next.photos.steps[edit.stepId] = structuredClone(edit.after); else delete next.photos.steps[edit.stepId];
      if (edit.afterOmission) (next.photos.omittedSteps ??= {})[edit.stepId] = structuredClone(edit.afterOmission);
      else if (next.photos.omittedSteps) delete next.photos.omittedSteps[edit.stepId];
      if (!edit.after) assert(validStepPhotoOmission(next, edit.stepId), `OMISSION_INVALID:${edit.stepId}`);
      changes.push({ kind: 'step', stepId: edit.stepId, signature: edit.signature, before: structuredClone(before), after: structuredClone(edit.after),
        beforeOmission: structuredClone(beforeOmission), afterOmission: structuredClone(edit.afterOmission), review: edit.review });
    }
  }
  return { content: next, changes };
}

export function buildDishStepPhotoRepairPlan(recipes: Recipe[], manifest: DishStepPhotoRepairManifest, context: {
  actor: Owner; databaseScope: string; manifestSha256: string; proofs: Proof[]; historyBefore: History;
}): DishStepPhotoRepairPlan {
  validateDishStepPhotoRepairManifest(manifest);
  const active = recipes.filter(row => !row.deleted_at), before = inventory(active), after = structuredClone(before), records: Record[] = [];
  for (const rule of manifest.rules) {
    const row = active.find(row => row.id === rule.recipeId); assert(row, 'RECIPE_OUTSIDE_SCOPE');
    if (rule.scope !== 'draft') assert(row.publication_status === 'published' && row.publication, 'PUBLICATION_OUTSIDE_SCOPE');
  }
  for (const row of active) {
    const draft = patchReviewedDishStepPhotos(row.content, row.id, 'draft', manifest);
    const publication = row.publication_status === 'published' && row.publication
      ? patchReviewedDishStepPhotos(row.publication.snapshot, row.id, 'publication', manifest) : null;
    if (!draft.changes.length && !publication?.changes.length) continue;
    const nextRevision = row.revision + 1, publicationId = publication?.changes.length ? randomUUID() : null;
    const record: Record = { recipeId: row.id, title: row.content.recipe.title.pl, nextRevision, draft: draft.changes, publication: publication?.changes ?? [],
      beforeDraft: structuredClone(row.content), afterDraft: draft.content, beforePublication: structuredClone(row.publication?.snapshot ?? null), afterPublication: publication?.content ?? null,
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
  return { version: 1, planId: randomUUID(), createdAt: new Date().toISOString(), ...context, manifest: structuredClone(manifest), before, after, records };
}

/** Recheck the whitelist and exact original snapshots even when an application is replayed. */
export function dishStepPhotoRepairPlanState(plan: DishStepPhotoRepairPlan, recipes: Recipe[]): 'before' | 'after' {
  validateDishStepPhotoRepairManifest(plan.manifest);
  for (const record of plan.records) {
    const before = plan.before.find(row => row.id === record.recipeId);
    assert(before && hash(record.beforeDraft) === before.content_hash, 'PLANNED_BEFORE_CONTENT_INVALID');
    const draft = patchReviewedDishStepPhotos(record.beforeDraft, record.recipeId, 'draft', plan.manifest);
    const publication = record.beforePublication ? patchReviewedDishStepPhotos(record.beforePublication, record.recipeId, 'publication', plan.manifest) : null;
    assert(same(draft.content, record.afterDraft) && same(draft.changes, record.draft) && hash(draft.content) === record.nextContentHash
      && same(publication?.changes ?? [], record.publication) && same(publication?.content ?? null, record.afterPublication)
      && (!record.publicationId || publication && hash(publication.content) === record.nextPublicationHash), 'PLANNED_CHANGES_INVALID');
    assert(!before.publication || record.beforePublication && hash(record.beforePublication) === before.publication.content_hash, 'PLANNED_PUBLICATION_BEFORE_INVALID');
  }
  return recipePhotoRepairPlanState(plan, recipes);
}

export function dishStepRepairMode(args: string[]): 'prepare' | 'preflight' | 'apply' {
  const modes = ['--prepare', '--preflight', '--apply'].filter(mode => args.includes(mode));
  assert(modes.length <= 1, 'CHOOSE_ONE_MODE');
  if (modes.length) return modes[0].slice(2) as 'prepare' | 'preflight' | 'apply';
  return args.some(arg => arg.startsWith('--manifest=')) ? 'prepare' : 'preflight';
}

/** A pending draft vessel must not weaken a publication-only pixel proof. */
export function dishStepHeroNeedsSolidProof(recipe: Recipe, selectedScopes: readonly Scope[]): boolean {
  assert(selectedScopes.length > 0, 'HERO_PROOF_SCOPE_MISSING');
  return selectedScopes.some(scope => {
    const content = scope === 'draft' ? recipe.content : recipe.publication_status === 'published' ? recipe.publication?.snapshot : null;
    assert(content, 'HERO_PROOF_SCOPE_MISSING');
    return !isGlassHeroPresentation(resolveHeroPresentation(content.recipe));
  });
}

const option = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
async function main() {
  const mode = dishStepRepairMode(process.argv.slice(2)), planPath = option('--plan'); assert(planPath, 'PLAN_REQUIRED');
  config({ path: option('--env') ?? '.env.production.local', quiet: true }); assert(process.env.DATABASE_URL, 'DATABASE_REQUIRED');
  const url = new URL(process.env.DATABASE_URL), databaseScope = hash(`${url.host}${url.pathname}:${url.username}`);
  url.searchParams.set('sslmode', 'verify-full'); process.env.DATABASE_URL = url.href;
  let reviewed: DishStepPhotoRepairPlan | undefined, manifest: DishStepPhotoRepairManifest, manifestSha256: string, planSha256: string | undefined;
  if (mode === 'prepare') {
    const manifestPath = option('--manifest'); assert(manifestPath, 'MANIFEST_REQUIRED'); const bytes = await readFile(resolve(manifestPath));
    manifest = JSON.parse(bytes.toString()); manifestSha256 = sha(bytes);
  } else {
    const bytes = await readFile(resolve(planPath)); planSha256 = sha(bytes); assert(option('--plan-sha256') === planSha256, 'EXACT_PLAN_SHA256_REQUIRED');
    reviewed = JSON.parse(bytes.toString()); assert(reviewed?.version === 1 && uuid.test(reviewed.planId) && reviewed.databaseScope === databaseScope, 'PLAN_SCOPE_INVALID');
    manifest = reviewed.manifest; manifestSha256 = reviewed.manifestSha256;
  }
  validateDishStepPhotoRepairManifest(manifest);
  const { getDb, closeDb } = await import('../src/server/db');
  const { contentApprovalHash } = await import('../src/server/editorial/content-approval');
  const { verifiedPublicationIssues } = await import('../src/server/editorial/store');
  const { invalidatePublicReadModel, refreshPublicReadModel } = await import('../src/server/public/read-model');
  const { getMediaBlob } = await import('../src/server/media/storage');
  const { validateCutout, validateSolidHeroCutout, validateVisiblePhoto } = await import('../src/server/ai/photo-format');
  try {
    const result = await getDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='10s'`);
      await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
      if (mode === 'apply') await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('repair-reviewed-dish-step-photos-v1'))`);
      const owners = (await tx.execute(mode === 'apply' ? sql`SELECT id,name FROM auth_user WHERE role='owner' AND NOT disabled ORDER BY id FOR SHARE`
        : sql`SELECT id,name FROM auth_user WHERE role='owner' AND NOT disabled ORDER BY id`)).rows as Owner[];
      assert(owners.length === 1, 'OWNER_AMBIGUOUS'); const actor = owners[0];
      const current = (await tx.execute(mode === 'apply' ? sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`
        : sql`SELECT * FROM editorial_recipe WHERE deleted_at IS NULL ORDER BY id`)).rows as Omit<Recipe, 'publication'>[];
      const publications = (await tx.execute(sql`SELECT p.* FROM editorial_publication p JOIN editorial_recipe r ON r.published_id=p.id
        WHERE r.deleted_at IS NULL AND r.publication_status='published' ORDER BY p.id`)).rows as NonNullable<Recipe['publication']>[];
      const rows: Recipe[] = current.map(row => ({ ...row, publication: publications.find(publication => publication.id === row.published_id) ?? null }));
      const history: History = {
        versions: (await tx.execute(sql`SELECT v.recipe_id,v.recipe_id||':'||v.revision AS key,v.content_hash,md5(to_jsonb(v)::text) AS row_hash
          FROM editorial_version v JOIN editorial_recipe r ON r.id=v.recipe_id WHERE r.deleted_at IS NULL ORDER BY v.recipe_id,v.revision`)).rows as HistoryRow[],
        publications: (await tx.execute(sql`SELECT p.recipe_id,p.id AS key,p.content_hash,md5(to_jsonb(p)::text) AS row_hash
          FROM editorial_publication p JOIN editorial_recipe r ON r.id=p.recipe_id WHERE r.deleted_at IS NULL ORDER BY p.id`)).rows as HistoryRow[],
        approvals: (await tx.execute(sql`SELECT a.recipe_id||':'||a.content_hash||':'||a.origin AS key,md5(to_jsonb(a)::text) AS row_hash
          FROM editorial_content_approval a JOIN editorial_recipe r ON r.id=a.recipe_id WHERE r.deleted_at IS NULL ORDER BY a.recipe_id,a.content_hash,a.origin`)).rows as History['approvals'],
      };
      const selections: { src: string; kind: 'hero' | 'step'; recipeId: string; targetId: string | null; scope: Scope }[] = [
        ...manifest.rules.flatMap(rule => scopes(rule.scope).flatMap(scope => [
          ...(rule.hero ? [{ src: rule.hero.after.src, kind: 'hero' as const, recipeId: rule.recipeId, targetId: null, scope }] : []),
          ...(rule.steps ?? []).flatMap(edit => edit.after ? [{ src: edit.after.src, kind: 'step' as const, recipeId: rule.recipeId, targetId: edit.stepId, scope }] : []),
        ])), ...(manifest.assetChecks ?? []).flatMap(check => {
          const row = rows.find(row => row.id === check.recipeId); assert(row, 'ASSET_CHECK_RECIPE_MISSING');
          return (row.publication_status === 'published' ? ['draft', 'publication'] as const : ['draft'] as const).map(scope => ({ ...check, scope }));
        }),
      ];
      const proofs: Proof[] = [];
      for (const src of [...new Set(selections.map(selection => selection.src))].sort()) {
        let bytes: Buffer, asset: Asset | null = null;
        if (src.startsWith('/media/')) {
          asset = (await tx.execute(sql`SELECT a.id,a.recipe_id,a.job_id,a.kind,a.target_id,a.blob_pathname,a.original_blob_pathname,a.width,a.height,
            j.recipe_id AS source_recipe_id,j.kind AS source_kind,j.target_id AS source_target_id,j.status AS source_status,j.result->'asset'->>'id' AS result_asset_id
            FROM ai_asset a JOIN ai_job j ON j.id=a.job_id WHERE a.id=${src.slice(7)}`)).rows[0] as Asset | undefined ?? null;
          assert(asset, 'REPLACEMENT_ASSET_MISSING');
          for (const selected of selections.filter(selection => selection.src === src)) assert(asset.recipe_id === selected.recipeId && asset.kind === selected.kind
            && asset.target_id === selected.targetId && asset.source_recipe_id === selected.recipeId && asset.source_kind === selected.kind
            && asset.source_target_id === selected.targetId && ['ready', 'applied'].includes(asset.source_status) && asset.result_asset_id === asset.id, 'REPLACEMENT_SOURCE_BINDING_INVALID');
          const blob = await getMediaBlob(asset.blob_pathname, { useCache: false }); assert(blob?.statusCode === 200, 'REPLACEMENT_UNAVAILABLE');
          const reader = blob.stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
          try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
            if (size > 32 * 1024 * 1024) { await reader.cancel(); throw Error('REPLACEMENT_TOO_LARGE'); } chunks.push(part.value); } }
          finally { reader.releaseLock(); } bytes = Buffer.concat(chunks, size);
        } else bytes = await readFile(resolve(`public${src}`));
        assert(bytes.length <= 32 * 1024 * 1024, 'REPLACEMENT_TOO_LARGE');
        const metadata = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
        assert(metadata.width && metadata.height && (metadata.pages ?? 1) === 1 && ['png', 'webp', 'jpeg'].includes(metadata.format ?? ''), 'REPLACEMENT_IMAGE_INVALID');
        assert(!asset || asset.width === metadata.width && asset.height === metadata.height, 'REPLACEMENT_DIMENSIONS_MISMATCH');
        const sourceSelections = selections.filter(selection => selection.src === src);
        assert(new Set(sourceSelections.map(selection => selection.kind)).size === 1, 'MIXED_PHOTO_KIND');
        if (sourceSelections[0].kind === 'hero') {
          await validateCutout(bytes);
          const glassOnly = sourceSelections.every(selection => {
            const row = rows.find(row => row.id === selection.recipeId); assert(row, 'ASSET_CHECK_RECIPE_MISSING');
            return !dishStepHeroNeedsSolidProof(row, [selection.scope]);
          });
          if (!glassOnly) await validateSolidHeroCutout(bytes);
        }
        else {
          await validateVisiblePhoto(bytes);
          assert(Math.abs(metadata.width / metadata.height - 21 / 9) <= 1 / metadata.height, 'STEP_ASPECT_RATIO_INVALID');
          if (metadata.hasAlpha) assert((await sharp(bytes).stats()).channels.at(-1)?.min === 255, 'STEP_NOT_OPAQUE');
        }
        for (const check of manifest.assetChecks?.filter(check => check.src === src) ?? []) assert(!check.sha256 || check.sha256 === sha(bytes), 'ASSET_CHECK_SHA_CHANGED');
        proofs.push({ src, sha256: sha(bytes), bytes: bytes.length, width: metadata.width, height: metadata.height, asset });
      }
      for (const check of manifest.assetChecks ?? []) {
        const current = rows.find(row => row.id === check.recipeId); assert(current, 'ASSET_CHECK_RECIPE_MISSING');
        const sample = structuredClone(current.content);
        if (check.kind === 'hero') sample.recipe.image = check.src;
        else {
          const step = sample.recipe.steps.find(step => step.id === check.targetId); assert(step, 'ASSET_CHECK_STEP_MISSING');
          sample.photos.steps[step.id] = { src: check.src, columns: 1, rows: 1, index: 0, alt: structuredClone(step.title), aspectRatio: 21 / 9 };
        }
        const target = check.kind === 'hero' ? 'image' : `steps.${check.targetId}.photo`;
        assert(!recipePhotoAssignmentIssues(sample).some(issue => issue.field === target), 'ASSET_CHECK_BINDING_INVALID');
      }
      if (reviewed) assert(same(proofs, reviewed.proofs), 'REPLACEMENT_PROOFS_CHANGED');
      const plan = reviewed ?? buildDishStepPhotoRepairPlan(rows, manifest, { actor, databaseScope, manifestSha256, proofs, historyBefore: history });
      assert(same(actor, plan.actor), 'OWNER_CHANGED');
      const state = dishStepPhotoRepairPlanState(plan, rows), action = `repair_dish_step_photos:${plan.planId}`;
      const receipts = (await tx.execute(sql`SELECT id,recipe_id,revision FROM editorial_audit WHERE action=${action} ORDER BY id`)).rows
        .map(row => ({ id: row.id, recipeId: row.recipe_id, revision: row.revision }));
      const expectedReceipts = plan.records.map(record => ({ id: record.auditId, recipeId: record.recipeId, revision: record.nextRevision })).sort((a, b) => a.id.localeCompare(b.id));
      const newVersionKeys = new Set(plan.records.map(record => `${record.recipeId}:${record.nextRevision}`)), newPublicationIds = new Set(plan.records.flatMap(record => record.publicationId ? [record.publicationId] : []));
      const priorHistory = state === 'after' ? { ...history, versions: history.versions.filter(row => !newVersionKeys.has(row.key)),
        publications: history.publications.filter(row => !newPublicationIds.has(row.key)) } : history;
      assert(same(priorHistory, plan.historyBefore), 'HISTORY_OR_APPROVAL_INVENTORY_CHANGED');
      if (state === 'after') {
        assert(same(receipts, expectedReceipts), 'APPLIED_RECEIPTS_MISSING');
        for (const record of plan.records) assert(history.versions.some(row => row.key === `${record.recipeId}:${record.nextRevision}` && row.content_hash === record.nextContentHash), 'APPLIED_VERSION_MISSING');
        return { mode, productionMutation: false, alreadyApplied: true, planSha256, changedRecipes: plan.records.length, changedPublications: newPublicationIds.size };
      }
      assert(!receipts.length, 'PARTIAL_APPLICATION_RECEIPT');
      for (const record of plan.records) {
        assert(contentApprovalHash(record.beforeDraft) === contentApprovalHash(record.afterDraft), 'CULINARY_CONTENT_CHANGED');
        if (record.beforePublication && record.afterPublication) assert(contentApprovalHash(record.beforePublication) === contentApprovalHash(record.afterPublication), 'PUBLISHED_CULINARY_CONTENT_CHANGED');
        for (const [scope, content, changes] of [['draft', record.afterDraft, record.draft], ['publication', record.afterPublication, record.publication]] as const) {
          if (!content || !changes.length) continue;
          const issues = [...recipePhotoAssignmentIssues(content), ...await verifiedPublicationIssues(content, tx)].filter(issue => changes.some(change => change.kind === 'hero'
            ? issue.field === 'image' || issue.field.startsWith('imageAlt.') : issue.field === `steps.${change.stepId}.photo` || issue.field.startsWith(`steps.${change.stepId}.photo.`)));
          assert(!issues.length, `CHANGED_PHOTO_POLICY_FAILED:${record.recipeId}`); void scope;
        }
      }
      const summary = { considered: rows.length, changedRecipes: plan.records.length, changedPublications: newPublicationIds.size,
        changedDraftPhotos: plan.records.reduce((n, record) => n + record.draft.length, 0), changedPublicPhotos: plan.records.reduce((n, record) => n + record.publication.length, 0),
        stepRemovals: plan.records.reduce((n, record) => n + [...record.draft, ...record.publication].filter(change => change.kind === 'step' && !change.after).length, 0) };
      if (mode === 'prepare') {
        const bytes = Buffer.from(JSON.stringify(plan, null, 2)); await writeFile(resolve(planPath), bytes, { mode: 0o600, flag: 'wx' });
        return { mode, productionMutation: false, planSha256: sha(bytes), ...summary };
      }
      if (mode === 'preflight') return { mode, productionMutation: false, planSha256, ...summary };
      const backup = option('--backup'); assert(backup, 'IMMUTABLE_BACKUP_REQUIRED');
      await writeFile(resolve(backup), JSON.stringify({ planSha256, recipes: rows, history, proofs }, null, 2), { mode: 0o600, flag: 'wx' });
      if (newPublicationIds.size) await invalidatePublicReadModel(tx);
      for (const record of plan.records) {
        const original = rows.find(row => row.id === record.recipeId)!, next = plan.after.find(row => row.id === record.recipeId)!;
        if (record.publicationId) { const prior = original.publication!;
          await tx.execute(sql`INSERT INTO editorial_publication (id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name,reviewed_by,reviewed_by_name,reviewed_revision)
            VALUES (${record.publicationId},${original.id},${record.nextRevision},${JSON.stringify(record.afterPublication)}::jsonb,${record.nextPublicationHash},${JSON.stringify(prior.checks)}::jsonb,
            'manual',${actor.id},${actor.name},${prior.reviewed_by},${prior.reviewed_by_name},${prior.reviewed_revision})`); }
        const updated = await tx.execute(sql`UPDATE editorial_recipe SET content=${JSON.stringify(record.afterDraft)}::jsonb,content_hash=${record.nextContentHash},revision=${record.nextRevision},
          checks_revision=${next.checks_revision},approved_revision=${next.approved_revision},published_id=${next.published_id},published_revision=${next.published_revision},
          updated_at=now(),updated_by=${actor.id},updated_by_name=${actor.name} WHERE id=${original.id} AND revision=${original.revision} AND content_hash=${original.content_hash} AND deleted_at IS NULL RETURNING id`);
        assert(updated.rows.length === 1, 'REVISION_CONFLICT');
        await tx.execute(sql`INSERT INTO editorial_version (recipe_id,revision,content,content_hash,reason,created_by,created_by_name)
          VALUES (${original.id},${record.nextRevision},${JSON.stringify(record.afterDraft)}::jsonb,${record.nextContentHash},${`${manifest.reason} Plan ${plan.planId}.`},${actor.id},${actor.name})`);
        await tx.execute(sql`INSERT INTO editorial_audit (id,recipe_id,revision,action,actor_id,actor_name) VALUES (${record.auditId},${original.id},${record.nextRevision},${action},${actor.id},${actor.name})`);
        if (record.publicationId) await tx.execute(sql`INSERT INTO editorial_outbox (id,recipe_id,revision,event) VALUES (${record.outboxId},${original.id},${record.nextRevision},'publish')`);
      }
      return { mode, productionMutation: plan.records.length > 0, planSha256, ...summary,
        revisions: plan.records.map(record => ({ recipeId: record.recipeId, revision: record.nextRevision, publicationId: record.publicationId })) };
    }, { isolationLevel: 'serializable', accessMode: mode === 'apply' ? 'read write' : 'read only' });
    console.log(JSON.stringify(result));
    if (mode === 'apply' && result.productionMutation && result.changedPublications) console.log(JSON.stringify({ readModel: await refreshPublicReadModel() }));
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
  const code = error instanceof Error ? error.message : 'UNKNOWN'; console.error('DISH_STEP_PHOTO_REPAIR_FAILED', /^[A-Z0-9_]+(?::[A-Za-z0-9_-]+)?$/.test(code) ? code : 'PRIVATE_DIAGNOSTIC_REQUIRED'); process.exitCode = 1;
});
