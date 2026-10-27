import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import ts from 'typescript';
import { BlobError, BlobServiceNotAvailable } from '@vercel/blob';
import type { EditorialContent } from '../../lib/editorial-types';
import { recipes } from '../../lib/recipes';
import { getIngredientImage, getStepImage } from '../../lib/recipe-media';
import { buildRecipeProposal, capturedRecipeProposalSchema, legacyRecipeProposalSchema, normalizeRecipeProposal, recipeProposalIssues, recipeProposalSchema, recipePresentationVersion, recipeProposalVersion, recipeResearchVersion } from './recipe-proposal';
import { approvedFalUrl, formatExistingHero, formatExistingStep, heroMaskPrompt, imageBill, imageBrief, imageSize, ingredientMaskPrompt, pollImage, readBounded, submitImage, recoverFailedHeroPhoto, recoverFailedPhoto, validateHeroCutoutSource, inspectAcceptedPhotoReceipt } from './image-provider';
import { filledHeroModel, heroCutoutModel, heroMaskPromptVersion, glassHeroMaskPromptVersion, stepFormatModel, approvedImageModel, isRecoverableHeroSource, isRecoverablePhotoSource, canRetryMissingIngredientMask, type FailedHeroSource } from './image-actions';
import { ingredientCutoutRecoveryBrief } from '@/lib/ai-types';
import { ingredientImageIdentity, ingredientStyleProfile, ingredientStudioBackgroundHex, paperIngredientStyleProfile, whiteIngredientStyleProfile } from './ingredient-profile';
import { pollText, responseRepairRequest, responseRequest, submitText, submitTextRepair, usageCost } from './text-provider';
import { recipeMethodInstructions, trendRecipeGenerationBrief } from './recipe-method';
import { ProviderError } from './provider-error';
import { isTransientPhotoResultRead, photoResultRecoveryError } from './result-recovery-error';
import { applyHeroMask, fillEnclosedCutout, validateSolidHeroCutout } from './photo-format';
import { z } from 'zod';
import { heroPresentationProfile, resolveHeroPresentationForBrief, type HeroContainer } from '../../lib/hero-presentation';
import type { PhotoReadDiagnostic } from './photo-read-diagnostic';

const imageModel = 'openai/gpt-image-2.5/sunburst/text-to-image';
const recipeModel = 'gpt-6-astra';

function original(): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  return {
    recipe,
    originalText: 'Oryginalne notatki autora. Zachowaj proporcje.',
    author: 'Autorka oryginału',
    sources: [{ id: 'human-source', title: 'Źródło podane przez autora', url: 'https://example.invalid/original' }],
    photos: {
      ingredients: Object.fromEntries(recipe.ingredients.map(item => [item.id, getIngredientImage(recipe.id, item.id)])),
      steps: Object.fromEntries(recipe.steps.map(item => [item.id, getStepImage(recipe.id, item.id)])),
    },
  };
}

function studioIngredientInput(profile: string = whiteIngredientStyleProfile): EditorialContent {
  return { ...original(), aiPhotography: { ingredientStyleProfile: profile } };
}

function isolatedImageStorage(sourceImage?: Buffer, sourceJobChanges: Record<string, unknown> = {}, sourceCutout?: Buffer, providerBackup?: Buffer, failures: { write?: Error; cutout?: Error } = {}) {
  const saved = new Map<string, Buffer>();
  const reads: string[] = [];
  const diagnostics: PhotoReadDiagnostic[] = [];
  const loadDependency = createRequire(import.meta.url);
  const source = ts.transpileModule(readFileSync(new URL('./image-provider.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports: Partial<typeof import('./image-provider')> = {};
  runInNewContext(source, {
    exports, Buffer, Blob, URL, AbortSignal, process,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
    require: (name: string) => {
      if (name === '@vercel/blob') return {
        get: async (pathname: string, options: { useCache?: boolean }) => {
          assert.equal(options.useCache, false);
          reads.push(pathname);
          const bytes = saved.get(pathname) ?? (pathname === 'test/web.webp' && sourceCutout ? sourceCutout : sourceImage);
          return bytes && (saved.has(pathname) || pathname.startsWith('test/')) ? { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }) } : null;
        },
        put: async (pathname: string, bytes: Buffer | Blob) => {
          if (failures.write) throw failures.write;
          // Match the storage SDK's supported binary bodies while retaining
          // the existing assertions against the exact uploaded pixels.
          saved.set(pathname, bytes instanceof Blob ? Buffer.from(await bytes.arrayBuffer()) : Buffer.from(bytes));
        },
      };
      if (name === './store') return {
        getAssetForExecution: () => sourceImage ? { id: 'ee0f47b4-aafb-4c37-9e32-76a1bbe078bb', jobId: 'source-mask-job', recipeId: recipes[0].id, kind: 'hero', model: heroCutoutModel, blobPathname: 'test/web.webp', originalBlobPathname: 'test/original.png' } : assert.fail('Standalone ingredient photography cannot read a hero asset.'),
        getJobForExecution: () => sourceImage ? { id: 'source-mask-job', recipeId: recipes[0].id, kind: 'hero', provider: 'fal', model: heroCutoutModel, status: 'ready', providerRequestId: 'accepted-mask-receipt', providerFinishedAt: new Date(), result: { asset: { id: 'ee0f47b4-aafb-4c37-9e32-76a1bbe078bb' } }, ...sourceJobChanges } : assert.fail('Standalone ingredient photography cannot read another generation.'),
      };
      if (name === './photo-format' && failures.cutout) return { ...loadDependency(name), validateCutout: async () => { throw failures.cutout; }, validateSolidHeroCutout: async () => { throw failures.cutout; } };
      if (name === './retained-photo-source') return { findRetainedPhotoSource: async () => null };
      if (name === './provider-backup') return { readProviderBackup: async () => providerBackup ?? null };
      if (name === './photo-read-diagnostic') {
        const diagnostic = loadDependency(name) as typeof import('./photo-read-diagnostic');
        return { ...diagnostic, withPhotoReadStage: <T>(context: Parameters<typeof diagnostic.withPhotoReadStage>[0], operation: () => T | Promise<T>) => diagnostic.withPhotoReadStage(context, operation, value => diagnostics.push(value)) };
      }
      if (name === '@/server/media/storage') return { getMediaBlob: (pathname: string, options: { useCache?: boolean }) => {
        assert.equal(options.useCache, false);
        reads.push(pathname);
        const bytes = saved.get(pathname) ?? (pathname === 'test/web.webp' && sourceCutout ? sourceCutout : sourceImage);
        return bytes && (saved.has(pathname) || pathname.startsWith('test/')) ? { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }) } : null;
      } };
      return loadDependency(name);
    },
  });
  assert.equal(typeof exports.pollImage, 'function');
  return { poll: exports.pollImage!, recover: exports.recoverFailedHeroPhoto!, repair: exports.formatExistingHero!, inspect: exports.inspectAcceptedPhotoReceipt!, saved, reads, diagnostics };
}

function proposal(input = original()): z.infer<typeof legacyRecipeProposalSchema> {
  const recipe = input.recipe;
  return {
    slug: structuredClone(recipe.slug), title: structuredClone(recipe.title), description: structuredClone(recipe.description),
    primaryCategory: recipe.primaryCategory, categories: [...recipe.categories], difficulty: recipe.difficulty,
    cuisine: structuredClone(recipe.cuisine), baseServings: recipe.baseServings, times: { ...recipe.times },
    ingredients: recipe.ingredients.map(item => ({
      ...structuredClone(item), note: item.note ?? null,
      amount: item.amount.kind === 'qualitative' ? item.amount : { ...item.amount, approximate: item.amount.approximate ?? false },
    })),
    steps: recipe.steps.map(item => ({ ...structuredClone(item), timerMinutes: item.timerMinutes ?? null })),
    equipment: structuredClone(recipe.equipment), tips: structuredClone(recipe.tips), storage: structuredClone(recipe.storage),
    scalingNote: recipe.scalingNote ?? null, notes: ['Sprawdź sos przed publikacją.'], substitutions: [],
  };
}

function currentHeroInput(container: HeroContainer = 'plate'): EditorialContent {
  const input = original();
  input.aiPhotography = { heroStyleProfile: heroPresentationProfile };
  input.recipe.heroPresentation = { container, finalAppearance: { pl: 'Gotowa potrawa w odpowiednim naczyniu.', en: 'The finished food in its final vessel.' }, evidenceStepIds: [input.recipe.steps.at(-1)!.id], profileVersion: heroPresentationProfile };
  return input;
}

async function sauceboatCutoutFixture() {
  const width = 100, height = 70;
  const source = await sharp({ create: { width, height, channels: 3, background: '#c89650' } }).png().toBuffer();
  const opacity = Buffer.alloc(width * height);
  for (let y = 10; y < 60; y++) for (let x = 10; x < 90; x++) opacity[y * width + x] = 255;
  for (let y = 17; y < 29; y++) for (let x = 20; x < 65; x++) opacity[y * width + x] = 0;
  for (let y = 15; y < 36; y++) for (let x = 80; x < 86; x++) opacity[y * width + x] = 0;
  const mask = await sharp(opacity, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return { source, mask, width };
}

async function glassCutoutFixture() {
  const width = 120, height = 160;
  const source = await sharp({ create: { width, height, channels: 3, background: '#d4c699' } }).png().toBuffer();
  const opacity = Buffer.alloc(width * height);
  for (let y = 10; y < 110; y++) for (let x = 15; x < 105; x++) opacity[y * width + x] = 100;
  for (let y = 25; y < 105; y++) for (let x = 30; x < 90; x++) opacity[y * width + x] = 255;
  for (let y = 110; y < 140; y++) for (let x = 53; x < 67; x++) opacity[y * width + x] = 100;
  for (let y = 140; y < 150; y++) for (let x = 30; x < 90; x++) opacity[y * width + x] = 100;
  const completeMask = await sharp(opacity, { raw: { width, height, channels: 1 } }).png().toBuffer();
  for (let y = 25; y < 90; y++) for (let x = 30; x < 90; x++) opacity[y * width + x] = 0;
  const vesselOnlyMask = await sharp(opacity, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return { source, completeMask, vesselOnlyMask, width };
}

function code(expected: string, uncertain?: boolean) {
  return (error: unknown) => error instanceof ProviderError && error.code === expected && (uncertain === undefined || error.uncertain === uncertain);
}

test('recipe proposals validate substitution quantities but leave acceptance to the owner', () => {
  const input = original();
  input.recipe.collection = 'trends';
  input.recipe.trendConfirmedAt = '2026-10-04T06:00:00.000Z';
  const raw = proposal(input);
  raw.substitutions = [{ id: 'alternative', ingredientId: input.recipe.ingredients[0].id,
    name: { pl: 'Makaron penne', en: 'Penne pasta' },
    note: { pl: 'Dostosuj czas do opakowania.', en: 'Follow the packet cooking time.' },
    amount: { kind: 'exact', value: '250', approximate: false }, unit: 'g', scaling: 'linear' }];
  const output = buildRecipeProposal(raw, input).content;
  assert.equal(output.recipe.substitutions?.[0].status, 'to_review');
  assert.equal(output.recipe.collection, 'trends');
  assert.equal(output.recipe.trendConfirmedAt, input.recipe.trendConfirmedAt);
  assert.deepEqual(output.sources, input.sources);
  const invalid = structuredClone(raw); invalid.substitutions[0].amount = { kind: 'exact', value: '0', approximate: false };
  assert.throws(() => buildRecipeProposal(invalid, input), code('AI_RESULT_INVALID'));
  const unknown = structuredClone(raw); unknown.substitutions[0].ingredientId = 'unrelated';
  assert.throws(() => buildRecipeProposal(unknown, input), code('AI_RESULT_INVALID'));
});

async function withCredentials<T>(run: () => Promise<T>): Promise<T> {
  const values = { OPENAI_API_KEY: 'unit-test-openai', FAL_KEY: 'unit-test-fal', FAL_API_KEY: undefined, FAL_BILLING_KEY: 'unit-test-billing', BLOB_READ_WRITE_TOKEN: 'unit-test-blob' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function networkGuard(url: RequestInfo | URL, init?: RequestInit) {
  const href = String(url instanceof Request ? url.url : url);
  const method = init?.method ?? (url instanceof Request ? url.method : 'GET');
  // Every transport test replaces fetch. Unknown URLs fail locally; they never
  // reach OpenAI, fal, Vercel Blob, a database or any other live service.
  assert.match(href, /^https:\/\/(?:api\.openai\.com\/v1\/responses|queue\.fal\.run\/openai\/gpt-image-2\.5\/(?:sunburst\/text-to-image|requests\/fake-[a-z-]+)|api\.fal\.ai\/v1\/models\/billing-events)(?:[/?]|$)/);
  return { href, method };
}

test('usage accounting separates regular input, cached reads, cache writes and output', () => {
  assert.equal(usageCost(recipeModel, { input_tokens: 1_000_000, output_tokens: 0 }).chargedUsd, '20.00000000');
  assert.equal(usageCost(recipeModel, { input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 1_000_000 } }).chargedUsd, '2.00000000');
  assert.equal(usageCost(recipeModel, { input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cache_write_tokens: 1_000_000 } }).chargedUsd, '25.00000000');
  const mixed = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } };
  assert.deepEqual(usageCost(recipeModel, mixed), { chargedUsd: '0.01395000', costBasis: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } });
  assert.equal(usageCost('gpt-6.1-sol', mixed).chargedUsd, '0.00277000');
  assert.equal(usageCost('gpt-6.1-sol', { input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 1_000_000 } }).chargedUsd, '0.20000000');
  assert.equal(usageCost('gpt-6.1-sol', { input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cache_write_tokens: 1_000_000 } }).chargedUsd, '5.00000000');
});

test('long-context pricing begins above 272K and applies to the whole request and all cache classes', () => {
  for (const model of ['gpt-6.1-sol', recipeModel]) {
    const atThreshold = usageCost(model, { input_tokens: 272_000, output_tokens: 1000 });
    const aboveThreshold = usageCost(model, { input_tokens: 272_001, output_tokens: 1000 });
    assert.equal(atThreshold.chargedUsd, model === recipeModel ? '2.77000000' : '0.55400000');
    assert.equal(aboveThreshold.chargedUsd, model === recipeModel ? '5.51502000' : '1.10300400');
    const cachedAndWritten = usageCost(model, { input_tokens: 300_000, output_tokens: 1000, input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 100_000 } });
    assert.equal(cachedAndWritten.chargedUsd, model === recipeModel ? '4.77500000' : '0.93500000');
  }
});

test('usage accounting rejects unknown models and impossible or overlapping counters', () => {
  assert.throws(() => usageCost('unapproved-model', { input_tokens: 1, output_tokens: 1 }), code('AI_MODEL_NOT_APPROVED'));
  for (const usage of [
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: Number.NaN, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 11 } },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 5 } },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: { cache_write_tokens: -1 } },
  ]) assert.throws(() => usageCost(recipeModel, usage), code('AI_USAGE_INVALID'));
});

test('the complete Responses request is byte bounded and worst-case rates fit the reservation', () => {
  const input = original();
  const request = responseRequest(recipeModel, input, 'Dopracuj obie wersje językowe.');
  assert.equal(request.background, true);
  assert.equal(request.store, true);
  assert.equal(request.service_tier, 'default');
  assert.equal(request.max_output_tokens, 24_000);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal('temperature' in request, false);
  assert.equal('top_p' in request, false);
  assert.equal('tools' in request, false);
  assert(Buffer.byteLength(JSON.stringify(request), 'utf8') <= 60_000);
  assert.equal(usageCost(recipeModel, { input_tokens: 60_000, output_tokens: 24_000, input_tokens_details: { cache_write_tokens: 60_000 } }).chargedUsd, '1.95000000');
  const oversized = original(); oversized.originalText = 'ą'.repeat(40_000);
  assert.throws(() => responseRequest(recipeModel, oversized, 'Krótki brief.'), code('AI_INPUT_TOO_LARGE'));
  assert.throws(() => responseRequest('unknown', input, 'Brief'), code('AI_MODEL_NOT_APPROVED'));
});

test('manual, trend and repair requests share method boundaries without an editorial step quota', () => {
  const input = original();
  for (const brief of ['Dopracuj przepis.', trendRecipeGenerationBrief, 'Maksymalnie 12 składników i 8 kroków.', 'Maksymalnie 8 składników i 6 kroków.']) {
    const request = responseRequest(recipeModel, input, brief);
    assert.ok(request.instructions.includes(recipeMethodInstructions));
    assert.match(request.instructions, /Never omit a necessary stage or pack independent stages/);
    assert.match(request.instructions, /do not pad a simple recipe/);
    assert.match(request.instructions, /observable completion cue/);
    assert.match(request.instructions, /when each timed interval starts/);
    assert.match(request.instructions, /what remains cooking or resting/);
    assert.equal(JSON.parse(request.input).brief, brief, 'Captured source data remains intact; the shared higher-priority method contract governs step boundaries.');
    const repair = responseRepairRequest(recipeModel, input, brief, 'resp_existing', [{ field: 'steps', message: 'Popraw kolejność etapów.' }]);
    assert.ok(repair.instructions.includes(recipeMethodInstructions));
    assert.equal(repair.max_output_tokens, request.max_output_tokens);
    assert.deepEqual(repair.text.format.schema, request.text.format.schema);
  }
  assert.ok(trendRecipeGenerationBrief.length <= 2000);
  assert.doesNotMatch(trendRecipeGenerationBrief, /maksymalnie\s+\d+|\d+\s+krok/i);
  const schema = responseRequest(recipeModel, input, trendRecipeGenerationBrief).text.format.schema;
  const steps = schema.properties?.steps as { description?: string; maxItems?: number; minItems?: number; items?: { properties?: Record<string, { description?: string }> } };
  assert.equal(steps.maxItems, undefined);
  assert.equal(steps.minItems, undefined, 'A simple method is not padded to an arbitrary minimum.');
  assert.match(steps.items?.properties?.text?.description ?? '', /completion cue/);
  assert.match(steps.items?.properties?.timerMinutes?.description ?? '', /one clearly identified continuous interval/);
});

test('Structured Outputs uses only supported unions and every object forbids extra fields', () => {
  const schema = responseRequest(recipeModel, original(), 'Brief').text.format.schema;
  let objects = 0; let unionBranches = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    assert.equal('oneOf' in record, false, 'OpenAI strict output supports anyOf, not oneOf');
    if (record.properties && typeof record.properties === 'object') {
      objects++;
      assert.equal(record.additionalProperties, false);
      assert.deepEqual(new Set(record.required as string[]), new Set(Object.keys(record.properties)));
    }
    if (Array.isArray(record.anyOf)) unionBranches += record.anyOf.length;
    Object.values(record).forEach(visit);
  };
  visit(schema);
  assert(objects >= 15); assert(unionBranches >= 3);
});

test('new text jobs suggest the final presentation in the existing strict response schema', () => {
  const input = original(); input.aiPhotography = { recipeProposalVersion };
  const request = responseRequest(recipeModel, input, 'Dopracuj przepis.');
  const schema = request.text.format.schema;
  assert(schema.required?.includes('heroPresentation'));
  assert.match(request.instructions, /entire method, not from its ingredient inventory/);
  assert.match(request.instructions, /Do not decorate blended sauces with raw fruit pieces/);
  assert.match(request.instructions, /Return null if/);
  assert.equal('tools' in request, false);
  const raw: z.infer<typeof recipeProposalSchema> = { ...proposal(input), heroPresentation: { container: 'bottle', finalAppearance: { pl: 'Gładki sos w butelce.', en: 'A smooth sauce in a bottle.' }, evidenceStepIds: [input.recipe.steps.at(-1)!.id] } };
  const result = buildRecipeProposal(raw, input);
  assert.equal(result.content.recipe.heroPresentation?.profileVersion, heroPresentationProfile);
  assert.equal(result.content.recipe.heroPresentation?.container, 'bottle');
  assert.deepEqual(result.content.recipe.steps, input.recipe.steps);
  assert.deepEqual(result.content.recipe.image, input.recipe.image);
  raw.heroPresentation!.evidenceStepIds = ['missing-step'];
  assert.throws(() => buildRecipeProposal(raw, input), code('AI_RESULT_INVALID'));
  raw.heroPresentation = null;
  const unresolved = buildRecipeProposal(raw, input).content;
  assert.equal(unresolved.recipe.heroPresentation, null);
  unresolved.aiPhotography = { ...unresolved.aiPhotography, heroStyleProfile: heroPresentationProfile };
  assert.throws(() => imageBrief('hero', unresolved, null, 'Brief'), code('AI_HERO_PRESENTATION_REQUIRED'), 'An explicit ambiguous AI suggestion must not become a locally inferred plate.');
});

test('legacy text jobs retain their old schema and parser after the new proposal version', () => {
  const input = currentHeroInput('jar'); delete input.aiPhotography;
  const request = responseRequest(recipeModel, input, 'Brief');
  assert.equal(request.text.format.schema.required?.includes('heroPresentation'), false);
  assert.doesNotMatch(request.instructions, /Suggest heroPresentation/);
  const result = buildRecipeProposal(proposal(input), input);
  assert.equal(result.content.recipe.heroPresentation, undefined, 'Legacy recipe changes cannot retain a stale final-state brief.');
  const next = { ...input, aiPhotography: { recipeProposalVersion } };
  assert.throws(() => buildRecipeProposal(proposal(input), next));
});

test('new presentation contracts return vessel and finished appearance with the recipe, while old receipts stay nullable', () => {
  const input = original(); input.aiPhotography = { recipeProposalVersion, recipePresentationVersion };
  const generation = responseRequest(recipeModel, input, 'Przygotuj pełny przepis.');
  assert.match(generation.instructions, /complete heroPresentation object in this same response, never null/);
  assert.match(generation.instructions, /internal provenance selected by you, never an editor checklist/);
  assert.doesNotMatch(generation.instructions, /Return null if/);
  const raw = { ...proposal(input), heroPresentation: { container: 'glass' as const,
    finalAppearance: { pl: 'Gładki chłodnik w kieliszku, z winogronami na wierzchu.', en: 'Smooth soup in a glass topped with grapes.' },
    evidenceStepIds: [input.recipe.steps.at(-1)!.id] } };
  assert.equal(capturedRecipeProposalSchema(input).safeParse(raw).success, true);
  assert.equal(buildRecipeProposal(raw, input).content.recipe.heroPresentation?.container, 'glass');
  assert.equal(capturedRecipeProposalSchema(input).safeParse({ ...raw, heroPresentation: null }).success, false);
  const repairablePresentation = (error: unknown) => error instanceof ProviderError && error.code === 'AI_RESULT_INVALID'
    && error.repairable && error.issues.some(issue => issue.field.startsWith('heroPresentation'));
  assert.throws(() => buildRecipeProposal({ ...raw, heroPresentation: null }, input), repairablePresentation);
  assert.throws(() => buildRecipeProposal({ ...raw, heroPresentation: { ...raw.heroPresentation, finalAppearance: { pl: '', en: '' } } }, input), repairablePresentation);
  const repair = responseRepairRequest(recipeModel, input, 'Brief', 'resp_existing_presentation', [{ field: 'heroPresentation', message: 'Uzupełnij gotowy opis.' }]);
  assert.deepEqual(repair.text.format.schema, generation.text.format.schema);
  assert.match(repair.instructions, /never null/);
  const old = { ...input, aiPhotography: { recipeProposalVersion } };
  assert.equal(capturedRecipeProposalSchema(old).safeParse({ ...raw, heroPresentation: null }).success, true);
  assert.equal(buildRecipeProposal({ ...raw, heroPresentation: null }, old).content.recipe.heroPresentation, null);
  assert.match(responseRequest(recipeModel, old, 'Brief').instructions, /Return null if/);
});

test('new recipe proposals can suggest a drinking glass without treating it as a jar or bottle', () => {
  const input = original(); input.aiPhotography = { recipeProposalVersion };
  const request = responseRequest(recipeModel, input, 'Ajo blanco w kieliszkach.');
  assert.match(request.instructions, /glass for food or drink finally served in a drinking glass/);
  assert.match(request.instructions, /glass used only to measure water.*does not establish the serving vessel/);
  const raw = { ...proposal(input), heroPresentation: { container: 'glass' as const,
    finalAppearance: { pl: 'Gładki biały chłodnik w kieliszku.', en: 'Smooth white chilled soup in an open goblet.' },
    evidenceStepIds: [input.recipe.steps.at(-1)!.id] } };
  const result = buildRecipeProposal(raw, input);
  assert.equal(result.content.recipe.heroPresentation?.container, 'glass');
  assert.equal(recipeProposalSchema.shape.heroPresentation.unwrap().shape.container.safeParse('glass').success, true);
});

test('generated recipe preserves human sources and input while keeping review claims honest', () => {
  const input = original(); input.recipe.provenance.kitchenTested = true;
  const snapshot = structuredClone(input);
  const raw = proposal(input); raw.title.pl = 'Tytuł propozycji';
  const result = buildRecipeProposal(raw, input);
  assert.deepEqual(input, snapshot);
  assert.equal(result.content.recipe.id, input.recipe.id);
  assert.equal(result.content.recipe.title.pl, raw.title.pl);
  assert.equal(result.content.originalText, input.originalText);
  assert.equal(result.content.author, input.author);
  assert.deepEqual(result.content.sources, input.sources);
  assert.deepEqual(result.content.photos, input.photos);
  assert.deepEqual(result.content.recipe.dietaryTags, []);
  assert.equal(result.content.recipe.provenance.type, 'ai_draft');
  assert.equal(result.content.recipe.provenance.kitchenTested, false);
  assert.doesNotMatch(result.content.recipe.provenance.note.pl, /poddano przeglądowi/i);
  assert.doesNotMatch(result.content.recipe.provenance.note.en, /and editorial review/i);
  assert.throws(() => buildRecipeProposal({ ...raw, sources: [{ url: 'https://invented.invalid' }] }, input));
  assert.throws(() => buildRecipeProposal({ ...raw, provenance: { kitchenTested: true } }, input));
});

test('recipe proposals reject external citations with repairable field issues before saving content', () => {
  const input = original();
  const cases: Array<{ field: string; change: (raw: ReturnType<typeof proposal>) => void }> = [
    { field: 'description.pl', change: raw => { raw.description.pl += ' Więcej na [cook.example](https://cook.example/recipe).'; } },
    { field: 'description.en', change: raw => { raw.description.en += ' Inspired by The Spruce Eats.'; } },
    { field: 'tips.pl', change: raw => { raw.tips.pl.push('Podobną korektę zaleca Whole Foods Market.'); } },
    { field: 'storage.en', change: raw => { raw.storage.en += ' See www.cooking.example for storage details.'; } },
    { field: 'steps.0.text.pl', change: raw => { raw.steps[0].text.pl += ' W przepisie AGFG stosuje się tę samą metodę.'; } },
    { field: 'ingredients.0.note.en', change: raw => { raw.ingredients[0].note = { pl: 'Wybierz świeży składnik.', en: 'For details visit https://cook.example/ingredients.' }; } },
  ];
  for (const item of cases) {
    const raw = proposal(input);
    item.change(raw);
    const before = structuredClone(raw);
    assert.throws(() => buildRecipeProposal(raw, input), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'AI_RESULT_INVALID');
      assert.equal(error.repairable, true);
      assert(error.issues.some(issue => issue.field.startsWith(item.field) && /samodzielną treść kulinarną/.test(issue.message)), item.field);
      return true;
    });
    assert.deepEqual(raw, before, 'Rejecting a citation must not silently alter the cooking instructions.');
  }
});

test('source-free proposals preserve private editorial source notes and bibliography', () => {
  const input = original();
  input.originalText = 'Notatki autora z https://cook.example/source. Według The Spruce Eats potrzebne jest pełne dogotowanie.';
  input.sources = [{ id: 'private-source', title: 'The Spruce Eats', url: 'https://cook.example/source' }];
  const output = buildRecipeProposal(proposal(input), input).content;
  assert.equal(output.originalText, input.originalText);
  assert.deepEqual(output.sources, input.sources);
  assert.deepEqual(output.recipe.steps, input.recipe.steps);
});

test('proposal validation rejects zero amounts, reversed ranges and inconsistent ingredient tokens', () => {
  const input = original();
  const zero = proposal(input); zero.ingredients[0].amount = { kind: 'exact', value: '0', approximate: false };
  assert.throws(() => buildRecipeProposal(zero, input), code('AI_RESULT_INVALID'));
  const range = proposal(input); range.ingredients[0].amount = { kind: 'range', min: '10', max: '1', approximate: false };
  assert.throws(() => buildRecipeProposal(range, input), code('AI_RESULT_INVALID'));
  const mismatch = proposal(input); mismatch.steps[0].text.en += ' {{pasta}}';
  assert.throws(() => buildRecipeProposal(mismatch, input), code('AI_RESULT_INVALID'));
  const missing = proposal(input); missing.steps[0].text.pl += ' {{unknown}}'; missing.steps[0].text.en += ' {{unknown}}';
  assert.throws(() => buildRecipeProposal(missing, input), code('AI_RESULT_INVALID'));
});

test('the production corn-ribs slug typo is normalized locally without changing recipe text, amounts or sources', () => {
  const input = original(); const raw = proposal(input); const baseline = buildRecipeProposal(raw, input).content;
  raw.slug.pl = 'corn-ribs-kukurydziane-zeberka-z-glazura-mas lano-miodowa';
  const snapshot = structuredClone(raw);
  const result = buildRecipeProposal(raw, input);
  assert.equal(result.content.recipe.slug.pl, 'corn-ribs-kukurydziane-zeberka-z-glazura-mas-lano-miodowa');
  assert.deepEqual(recipeProposalIssues(raw, input), []);
  assert.deepEqual(result.content.recipe.ingredients, baseline.recipe.ingredients);
  assert.deepEqual(result.content.recipe.steps, baseline.recipe.steps);
  assert.deepEqual(result.content.sources, input.sources);
  assert.deepEqual(raw, snapshot);
});

test('representation normalization preserves exact finite amounts and never rounds recurring or contradictory quantities', () => {
  const input = original();
  for (const [rawValue, expected] of [[' 1,25 ', '1.25'], ['1/2', '0.5'], ['1 3/8', '1.375'], ['1½', '1.5'], ['⅛', '0.125']]) {
    const raw = proposal(input); raw.ingredients[0].amount = { kind: 'exact', value: rawValue, approximate: false };
    const result = buildRecipeProposal(raw, input).content.recipe.ingredients[0].amount;
    assert.equal(result.kind, 'exact'); if (result.kind === 'exact') assert.equal(result.value, expected);
  }
  for (const value of ['1/3', '2 2/3', '0', '-1', '1/0', '1e3']) {
    const raw = proposal(input); raw.ingredients[0].amount = { kind: 'exact', value, approximate: false };
    assert.throws(() => buildRecipeProposal(raw, input), error => error instanceof ProviderError && error.repairable
      && error.issues.some(issue => issue.field.startsWith('ingredients.')));
  }
});

test('ID normalization updates only unambiguous references and never drops duplicate ingredients to silence validation', () => {
  const input = original(); const raw = proposal(input); const previous = raw.ingredients[0].id;
  raw.ingredients[0].id = ' ilość makaronu ';
  for (const step of raw.steps) for (const locale of ['pl', 'en'] as const) step.text[locale] = step.text[locale].replaceAll(`{{${previous}}}`, '{{ ilość makaronu }}');
  const normalized = buildRecipeProposal(raw, input).content;
  assert.equal(normalized.recipe.ingredients[0].id, 'ilosc_makaronu');
  assert.ok(normalized.recipe.steps.some(step => step.text.pl.includes('{{ilosc_makaronu}}')));
  assert.equal(normalized.recipe.ingredients.length, raw.ingredients.length);
  const duplicates = proposal(input); duplicates.ingredients[1].id = duplicates.ingredients[0].id;
  assert.throws(() => buildRecipeProposal(duplicates, input), error => error instanceof ProviderError
    && error.issues.some(issue => issue.message.includes('powtarza')));
  assert.equal((normalizeRecipeProposal(duplicates) as typeof duplicates).ingredients.length, duplicates.ingredients.length);
  const mismatch = proposal(input); mismatch.steps[0].text.en += ' {{unknown}}';
  const issues = recipeProposalIssues(mismatch, input);
  assert.ok(issues.some(issue => issue.field.startsWith('steps.') && issue.message.includes('nieznanego')));
  assert.ok(issues.some(issue => issue.message.includes('różnią')));
});

test('removed ingredient and step IDs cannot retain unrelated visual materials', () => {
  const input = original(); const raw = proposal(input);
  raw.ingredients = raw.ingredients.filter(item => item.id !== 'basil');
  const removedStep = raw.steps.pop()!;
  const result = buildRecipeProposal(raw, input);
  assert.equal('basil' in result.content.photos.ingredients, false);
  assert.equal(removedStep.id in result.content.photos.steps, false);
  assert.equal('pasta' in result.content.photos.ingredients, true);
  assert.equal('pasta' in result.content.photos.steps, true);
});

test('fal URLs permit exact approved HTTPS hosts and reject credentials and lookalikes', () => {
  for (const host of ['fal.media', 'v3.fal.media', 'v3b.fal.media']) assert.equal(approvedFalUrl('https://' + host + '/image.png?signature=example').hostname, host);
  for (const url of [
    'http://fal.media/image.png', 'https://fal.media:8443/image.png', 'https://user@fal.media/image.png',
    'https://user:password@v3.fal.media/image.png', 'https://fal.media.evil.invalid/image.png',
    'https://evil.invalid/fal.media/image.png', 'https://subdomain.fal.media/image.png',
    'https://127.0.0.1/image.png', 'file:///tmp/image.png', 'data:image/png;base64,AA==',
  ]) assert.throws(() => approvedFalUrl(url), code('AI_IMAGE_URL_INVALID'));
  assert.throws(() => approvedFalUrl('not-a-url'));
});

test('bounded image reader enforces decoded stream limits even without Content-Length', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4, 5])); controller.close(); } });
  assert.deepEqual(await readBounded(stream, 5), Buffer.from([1, 2, 3, 4, 5]));
  assert.equal(stream.locked, false);
  let cancelled = false;
  const large = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBounded(large, 5), code('AI_IMAGE_TOO_LARGE'));
  assert.equal(cancelled, true); assert.equal(large.locked, false);
  await assert.rejects(readBounded(null), code('AI_IMAGE_EMPTY'));
});

test('image prompt resolves quantities and focuses on the selected culinary detail', () => {
  const input = original();
  const hero = imageBrief('hero', input, null, 'Miękkie światło');
  assert(hero.includes(input.recipe.title.en)); assert(hero.includes('Ingredients actually present'));
  assert.match(hero, /complete ceramic bowl or plate.*fully transparent background/);
  assert.match(hero, /entire rim and vessel visible/);
  assert.match(hero, /No table, napkin, linen, utensils, props or surrounding scenery/);
  assert.match(hero, /Strict true 90-degree overhead flat lay/);
  assert.match(hero, /camera is directly above the centre.*perpendicular to the food surface/);
  assert.match(hero, /No oblique or three-quarter angle, no perspective foreshortening, no visible front or outer sidewall/);
  assert.match(hero, /entire food surface and ceramic rim sharply in focus/);
  assert.match(hero, /food and vessel must remain opaque together/);
  assert.doesNotMatch(hero, /shallow depth of field/);
  const ingredient = imageBrief('ingredient', input, 'cheese', 'Detal faktury');
  assert(ingredient.includes(input.recipe.ingredients.find(item => item.id === 'cheese')!.name.en));
  assert(ingredient.includes('fully transparent background'));
  assert.doesNotMatch(ingredient, /Strict true 90-degree overhead flat lay/);
  const step = imageBrief('step', input, 'sauce', 'Pokaż konsystencję');
  assert(step.includes('tight macro')); assert(step.includes('40 g')); assert(step.includes('200 ml'));
  assert.doesNotMatch(step, /Strict true 90-degree overhead flat lay/);
  assert.doesNotMatch(step, /\{\{[^}]+\}\}/);
  assert.throws(() => imageBrief('step', input, 'missing-step', 'Brief'), code('AI_TARGET_MISSING'));
  assert.throws(() => imageBrief('hero', input, null, 'ą'.repeat(32_001)), code('AI_INPUT_TOO_LARGE'));
});

test('current heroes show the final blended sauce and actual final container', () => {
  const input = currentHeroInput('bottle');
  input.recipe.title = { pl: 'Sos owocowy', en: 'Fruit sauce' };
  input.recipe.steps = [
    { id: 'blend', title: { pl: 'Zmiksuj sos', en: 'Blend the sauce' }, text: { pl: 'Zmiksuj owoce na gładki sos.', en: 'Blend the fruit to a completely smooth sauce.' } },
    { id: 'bottle', title: { pl: 'Rozlej sos', en: 'Bottle the sauce' }, text: { pl: 'Przelej sos do butelki i zamknij korkiem.', en: 'Pour the sauce into a bottle and close it with a cork.' } },
  ];
  input.recipe.heroPresentation = { container: 'bottle', finalAppearance: { pl: 'Gładki sos owocowy w zakorkowanej butelce.', en: 'Completely smooth fruit sauce in a corked glass bottle.' }, evidenceStepIds: ['blend', 'bottle'], profileVersion: heroPresentationProfile };
  const prompt = imageBrief('hero', input, null, 'Miękkie światło');
  assert.match(prompt, /Completely smooth fruit sauce in a corked glass bottle/);
  assert.match(prompt, /Blend the fruit to a completely smooth sauce/);
  assert.match(prompt, /Pour the sauce into a bottle and close it with a cork/);
  assert.match(prompt, /three-quarter view/);
  assert.match(prompt, /Never show pre-blending chunks in a smooth sauce/);
  assert.doesNotMatch(prompt, /Strict true 90-degree overhead|complete ceramic bowl or plate/);
  assert.match(heroMaskPrompt(input), /glass bottle.*neck.*cork.*finished food contents/);
  input.recipe.heroPresentation.container = 'jar';
  assert.match(imageBrief('hero', input, null, 'Brief'), /one clear glass jar/);
  assert.match(heroMaskPrompt(input), /glass jar.*lid or closure/);
  input.recipe.heroPresentation.container = 'sauceboat';
  assert.match(imageBrief('hero', input, null, 'Brief'), /one small ceramic sauce boat with a spout/);
  assert.match(heroMaskPrompt(input), /sauce boat including its handle and spout/);
  assert.match(heroMaskPrompt(input), /excluding the background visible through the open gap inside its handle/);
});

test('cookware heroes capture the natural-language vessel and preserve final toppings and handle apertures', () => {
  const input = currentHeroInput('plate');
  input.recipe.title = { pl: 'Kurczak z ryżem w glinianym garnku', en: 'Clay pot chicken and rice' };
  input.recipe.steps = [
    { id: 'cook', title: { pl: 'Ugotuj', en: 'Cook' }, text: { pl: 'Gotuj kurczaka i ryż w glinianym garnku.', en: 'Cook the chicken and rice in a clay pot.' } },
    { id: 'serve', title: { pl: 'Podaj', en: 'Serve' }, text: { pl: 'Na wierzchu ułóż marynowane żółtko.', en: 'Top the finished dish with the marinated egg yolk.' } },
  ];
  input.recipe.heroPresentation!.evidenceStepIds = ['cook'];
  const brief = 'Pokaż potrawę w glinianym garnku zamiast talerza. Na wierzchu ma być marynowane żółtko.';
  input.aiPhotography!.heroPresentationOverride = resolveHeroPresentationForBrief(input.recipe, brief)!;
  const prompt = imageBrief('hero', input, null, brief);
  assert.match(prompt, /Final vessel: one earthenware clay cooking pot/);
  assert.match(prompt, /Top the finished dish with the marinated egg yolk/);
  assert.match(prompt, /including every topping and garnish added in the final steps/);
  assert.match(prompt, /natural-language photo instructions/);
  assert.match(prompt, /Editor’s requested photo changes.*Pokaż potrawę w glinianym garnku/);
  assert.doesNotMatch(prompt, /Final vessel: one simple round ceramic plate|Strict true 90-degree overhead/);
  assert.equal(input.recipe.heroPresentation!.container, 'plate', 'The approved recipe stays unchanged.');
  input.aiPhotography!.heroPresentationOverride = { ...input.recipe.heroPresentation!, container: 'clay-pot' };
  assert.match(heroMaskPrompt(input), /clay cooking pot.*rim and handles.*finished food contents/);
  assert.match(heroMaskPrompt(input), /excluding the background visible through any open gap inside its handles/);
  // A persisted photo choice is authoritative for later masking and recovery.
  assert.match(imageBrief('hero', input, null, 'Zachowaj obecne zdjęcie.'), /Final vessel: one earthenware clay cooking pot/);
  for (const container of ['pan', 'pot', 'baking-dish', 'platter'] as const) {
    input.aiPhotography!.heroPresentationOverride.container = container;
    assert.doesNotThrow(() => imageBrief('hero', input, null, 'Zachowaj finalną potrawę.'));
    assert.doesNotThrow(() => heroMaskPrompt(input));
    assert(recipeProposalSchema.shape.heroPresentation.unwrap().shape.container.safeParse(container).success);
  }
});

test('drinking-glass heroes preserve the open rim, stem and intentional transparency without jar or bottle instructions', () => {
  const input = currentHeroInput('glass');
  input.recipe.title = { pl: 'Ajo blanco', en: 'Ajo blanco' };
  input.recipe.heroPresentation!.finalAppearance = { pl: 'Gładki biały chłodnik w kieliszku na nóżce.', en: 'Smooth white chilled soup in an open stemmed goblet.' };
  const prompt = imageBrief('hero', input, null, 'Pokaż gotową potrawę w kieliszku.');
  assert.match(prompt, /Final vessel: one clear drinking glass or goblet/);
  assert.match(prompt, /complete body and any stem and foot visible/);
  assert.match(prompt, /Preserve intentional glass transparency/);
  assert.match(prompt, /Never add a jar lid, bottle neck or closure/);
  assert.doesNotMatch(prompt, /Final vessel: one clear glass (?:jar|bottle)|Strict true 90-degree overhead/);
  assert.match(heroMaskPrompt(input), /drinking glass or goblet.*open rim.*stem and foot/);
  input.aiPhotography!.heroMaskPromptVersion = heroMaskPromptVersion;
  assert.equal(heroMaskPrompt(input), 'drinking glass');
});

test('a manual hero retake can place a prepared yolk whole on top despite older serving-arrangement prohibitions', () => {
  const input = currentHeroInput('plate');
  input.recipe.title = { pl: 'Kurczak z ryżem w glinianym garnku', en: 'Clay pot chicken and rice' };
  input.recipe.ingredients = [
    { id: 'chicken', name: { pl: 'Kurczak', en: 'Chicken' }, amount: { kind: 'exact', value: '300' }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' } },
    { id: 'rice', name: { pl: 'Ryż', en: 'Rice' }, amount: { kind: 'exact', value: '200' }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' } },
    { id: 'yolk', name: { pl: 'Marynowane żółtko', en: 'Marinated egg yolk' }, amount: { kind: 'exact', value: '1' }, unit: 'count', scaling: 'linear', group: { pl: '', en: '' } },
  ];
  input.recipe.steps = [
    { id: 'cook', title: { pl: 'Ugotuj', en: 'Cook' }, text: { pl: 'Gotuj ryż i kurczaka w glinianym garnku, aż ryż wchłonie wodę, a kurczak będzie całkowicie ugotowany.', en: 'Cook the rice and chicken in a clay pot until the rice absorbs the water and the chicken is fully cooked.' } },
    { id: 'serve', title: { pl: 'Podaj', en: 'Serve' }, text: { pl: 'Rozbij marynowane żółtko i wmieszaj w ryż. Przełóż na głęboki talerz.', en: 'Break the marinated egg yolk and stir it into the rice. Transfer to a deep plate.' } },
  ];
  input.recipe.heroPresentation = {
    container: 'plate', evidenceStepIds: ['cook', 'serve'], profileVersion: heroPresentationProfile,
    finalAppearance: {
      pl: 'Marynowane żółtko wmieszane w ryż; nigdy nie pozostaje w całości na wierzchu.',
      en: 'The marinated yolk is stirred into the rice; it is never left whole on top.',
    },
  };
  const brief = 'Pokaż potrawę w glinianym garnku zamiast talerza. Na wierzchu ułóż całe marynowane żółtko.';
  input.aiPhotography!.heroPresentationOverride = resolveHeroPresentationForBrief(input.recipe, brief)!;
  input.aiPhotography!.regenerate = true;
  const before = structuredClone(input);
  const prompt = imageBrief('hero', input, null, brief);
  assert.match(prompt, /explicit manual photo retake.*take priority for final plating, arrangement and topping placement/);
  assert.match(prompt, /A prepared topping may be reserved whole on top instead of stirred in or broken during serving/);
  assert.match(prompt, /Earlier presentation reference; final arrangement and topping-placement prohibitions are subordinate/);
  assert.match(prompt, /it is never left whole on top/, 'The old description remains clearly labelled source context.');
  assert.match(prompt, /explicit request to show a prepared recipe topping whole on top overrides earlier text/);
  assert.match(prompt, /Preserve recipe ingredient identity, cooking and preparation transformations, doneness and the required image format/);
  assert.match(prompt, /chicken is fully cooked/);
  assert.match(prompt, /Final vessel: one earthenware clay cooking pot/);
  assert.match(prompt, /Use the captured vessel only as a default when the editor does not specify one/);
  assert.doesNotMatch(prompt, /The completed method determines the food state|Show the completed food exactly in this final state/);
  assert.deepEqual(input, before, 'A photo retake does not rewrite the approved recipe.');
  // Previously captured jobs preserve their method-derived arrangement policy.
  delete input.aiPhotography!.regenerate;
  const historical = imageBrief('hero', input, null, brief);
  assert.match(historical, /The completed method determines the food state/);
  assert.match(historical, /Show the completed food exactly in this final state/);
  assert.doesNotMatch(historical, /explicit manual photo retake|topping-placement prohibitions are subordinate/);
});

test('manual hero retakes fit nine detailed stages without discarding culinary instructions', () => {
  const input = currentHeroInput('clay-pot');
  const names = ['Chicken thigh', 'Rice', 'Marinated egg yolk', 'Light soy sauce', 'Dark soy sauce', 'Sesame oil', 'Ginger', 'Garlic', 'Spring onion', 'Shiitake mushroom', 'Water', 'Shaoxing wine', 'Cornflour', 'Sugar', 'White pepper', 'Neutral oil', 'Salt'];
  const note = 'Ingredient selection, storage and substitution information for the editor.';
  input.recipe.ingredients = names.map((name, index) => ({ ...structuredClone(input.recipe.ingredients[0]), id: `ingredient-${index}`, name: { pl: name, en: name }, note: { pl: note, en: note } }));
  const methods = [
    'Marinate the yolk until its exterior is firm and the centre remains thick, glossy and intact; keep it reserved.',
    'Rinse the rice until the water runs clear, then drain thoroughly so the measured cooking liquid remains accurate.',
    'Coat the chicken evenly with its marinade and leave it ready for the covered cooking stage without browning it yet.',
    'Soak the mushrooms until pliable, remove the tough stems and cut them into even pieces before adding them.',
    'Prepare the ginger, garlic and spring onion so their pieces cook evenly and the green tops remain reserved.',
    'Spread the rice evenly in the clay pot, pour in the cooking liquid and arrange the chicken and mushrooms above it.',
    'Cover and cook gently until the liquid simmers throughout the pot and the rice begins absorbing it evenly.',
    'Continue cooking until the chicken is fully cooked and the rice is tender; adjust the heat if the base darkens too quickly.',
    'Rest the covered pot, then uncover it and finish with the reserved prepared yolk and spring onion tops before serving.',
  ];
  const detail = 'Keep the heat gentle, inspect the food before moving to the next stage, and check the texture at the centre as well as the edges. The mixture should cook evenly without a dry upper layer or a scorched base. Preserve the prepared ingredients for the next stage and keep every visible component in the state described here.';
  const culinaryInstructions = methods.map(method => `${method} ${detail}`);
  input.recipe.steps = culinaryInstructions.map((text, index) => ({ id: `stage-${index + 1}`, title: { pl: `Etap ${index + 1}`, en: `Stage ${index + 1}` }, text: { pl: text, en: text } }));
  input.recipe.steps[3].text.en += ` [Source cue](https://culinary.example.invalid/reference?source=${'reference'.repeat(60)}) [1]`;
  input.recipe.heroPresentation!.evidenceStepIds = ['stage-8', 'stage-9'];
  input.aiPhotography!.regenerate = true;
  const before = structuredClone(input);
  const prompt = imageBrief('hero', input, null, 'Pokaż potrawę w glinianym garnku z całym marynowanym żółtkiem na wierzchu.');
  assert(Buffer.byteLength(prompt, 'utf8') <= 8_000);
  for (const text of culinaryInstructions) assert(prompt.includes(text), 'Every full culinary stage must remain in the prompt.');
  for (const name of names) assert(prompt.includes(name));
  assert.doesNotMatch(prompt, /https:\/\/|\[1\]/);
  assert(!prompt.includes(note), 'Source ingredient notes do not define visible finished-dish components.');
  assert.match(prompt, /fully transparent exterior background around the complete composition and through open handle gaps/);
  assert.match(prompt, /Never show pre-blending chunks in a smooth sauce/);
  assert.deepEqual(input, before);
  delete input.aiPhotography!.regenerate;
  const standard = imageBrief('hero', input, null, 'Pokaż potrawę.');
  for (const text of culinaryInstructions) assert(standard.includes(text), 'Standard photographs retain every full culinary stage too.');
  assert(Buffer.byteLength(standard, 'utf8') > 8_000, 'A valid photograph must not be rejected by the old application byte cap.');
});

test('versioned hero masks use one concise vessel concept while preserving historical prompt contracts', () => {
  const input = currentHeroInput('plate');
  input.aiPhotography!.heroPresentationOverride = { ...input.recipe.heroPresentation!, container: 'clay-pot' };
  assert.equal(heroMaskPrompt(input), 'the entire earthenware clay cooking pot including its complete body, rim and handles and all its finished food contents, preserving the complete vessel outline, excluding the background visible through any open gap inside its handles');
  input.aiPhotography!.heroMaskPromptVersion = heroMaskPromptVersion;
  const concepts: Record<HeroContainer, string> = { plate: 'plate', bowl: 'bowl', sauceboat: 'sauce boat', jar: 'jar', bottle: 'bottle', glass: 'drinking glass', 'clay-pot': 'clay pot', pot: 'pot', pan: 'pan', 'baking-dish': 'baking dish', platter: 'platter' };
  for (const [container, concept] of Object.entries(concepts)) {
    input.aiPhotography!.heroPresentationOverride.container = container as HeroContainer;
    const prompt = heroMaskPrompt(input);
    assert.equal(prompt, concept);
    assert.match(prompt, /^[a-z]+(?: [a-z]+){0,2}$/, 'SAM receives one object concept rather than editing instructions.');
    assert.doesNotMatch(prompt, /including|excluding|preserv|entire|contents|background/);
  }
  const legacy = original();
  assert.equal(heroMaskPrompt(legacy), 'the entire ceramic bowl or plate including its complete rim and all the food inside');
  legacy.aiPhotography = { heroMaskPromptVersion };
  assert.equal(heroMaskPrompt(legacy), 'serving dish');
});

test('new glass mask captures request both the vessel and its food without changing the historical vessel-only prompt', () => {
  const input = currentHeroInput('glass');
  input.aiPhotography!.heroMaskPromptVersion = glassHeroMaskPromptVersion;
  assert.equal(heroMaskPrompt(input), 'drinking glass with all its food contents');
  input.aiPhotography!.heroMaskPromptVersion = heroMaskPromptVersion;
  assert.equal(heroMaskPrompt(input), 'drinking glass');
});

test('execution never reinterprets a historical hero brief into another vessel', () => {
  const input = currentHeroInput('plate');
  const prompt = imageBrief('hero', input, null, 'Zamiast talerza użyj glinianego garnka.');
  assert.match(prompt, /Final vessel: one simple round ceramic plate/);
  assert.match(prompt, /brief text cannot change that choice during execution/);
  assert.match(heroMaskPrompt(input), /ceramic plate/);
  assert.doesNotMatch(heroMaskPrompt(input), /clay cooking pot/);
});

test('final hero receives every approved method step, including steps outside selected final-state evidence', () => {
  const input = currentHeroInput('plate');
  input.recipe.steps[0].text.en = 'Roast the aubergine until completely tender before any mixing.';
  input.recipe.heroPresentation!.evidenceStepIds = [input.recipe.steps.at(-1)!.id];
  const prompt = imageBrief('hero', input, null, 'Photograph the finished recipe.');
  assert.match(prompt, /Complete approved method; every step has already been completed/);
  assert.match(prompt, /Roast the aubergine until completely tender before any mixing/);
});

test('steps prepared before the hero use their complete method without an unavailable finished-dish reference', () => {
  const input = original(); input.recipe.image = '';
  const prompt = imageBrief('step', input, input.recipe.steps[0].id, 'Photograph this preparation stage.');
  assert.match(prompt, /The final dish has not been photographed yet/);
  assert.match(prompt, /Current step 1 of/);
  assert.doesNotMatch(prompt, /finished-dish reference is STYLE ONLY/);
});

test('current plated heroes preserve round overhead styling while legacy jobs ignore new metadata', () => {
  const input = currentHeroInput();
  const current = imageBrief('hero', input, null, 'Brief');
  assert.match(current, /one simple round ceramic plate/);
  assert.match(current, /Strict true 90-degree overhead flat lay/);
  const old = original();
  const expected = imageBrief('hero', old, null, 'Brief');
  input.aiPhotography = undefined;
  assert.equal(imageBrief('hero', input, null, 'Brief'), expected);
  assert.equal(heroMaskPrompt(input), 'the entire ceramic bowl or plate including its complete rim and all the food inside');
});

test('unresolved new hero presentation fails before paid transport or budget admission', async t => {
  await withCredentials(async () => {
    const input = currentHeroInput('jar'); delete input.recipe.heroPresentation;
    input.recipe.title = { pl: 'Cowboy candy', en: 'Cowboy candy' };
    let requests = 0; let admissions = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unresolved presentation cannot reach the provider'); });
    await assert.rejects(submitImage(imageModel, 'hero', input, null, 'Brief', async () => { admissions++; }), code('AI_HERO_PRESENTATION_REQUIRED'));
    assert.equal(requests, 0); assert.equal(admissions, 0);
  });
});

test('white ingredient photography uses only the selected product and its required preparation form', () => {
  const input = studioIngredientInput();
  const ingredient = input.recipe.ingredients.find(item => item.id === 'cheese')!;
  ingredient.name = { pl: 'Orzechy włoskie', en: 'Walnuts' };
  ingredient.note = { pl: 'Zmielone. Dodaj później do dania.', en: 'Ground. Add to the finished dish later.' };
  input.recipe.title.en = 'A cooked dinner with sauce';
  const prompt = imageBrief('ingredient', input, ingredient.id, 'Show the walnut texture.');
  assert.match(prompt, /studio product photograph.*Walnuts/);
  assert.match(prompt, /Required ingredient form: ground/);
  assert.match(prompt, /Pure white \(#FFFFFF\) opaque seamless studio background/);
  assert.match(prompt, /natural soft contact shadow/);
  assert.match(prompt, /whole ingredient.*sharply in focus/);
  assert.match(prompt, /full contact shadow remain inside the frame/);
  assert.doesNotMatch(prompt, /A cooked dinner with sauce|Ingredients actually present|warm ivory|Reference image|fully transparent background|Add to the finished dish later/);
  assert.throws(() => imageBrief('ingredient', input, 'missing-ingredient', 'Product'), code('AI_TARGET_MISSING'));
  assert.throws(() => imageBrief('ingredient', input, ingredient.id, 'ą'.repeat(32_001)), code('AI_INPUT_TOO_LARGE'));
});

test('paper ingredient photography matches the site colour without changing the selected product', () => {
  const input = studioIngredientInput(paperIngredientStyleProfile);
  const ingredient = input.recipe.ingredients.find(item => item.id === 'cheese')!;
  ingredient.name = { pl: 'Orzechy włoskie', en: 'Walnuts' };
  ingredient.note = { pl: 'Zmielone. Dodaj później do dania.', en: 'Ground. Add to the finished dish later.' };
  input.recipe.title.en = 'A cooked dinner with sauce';
  const prompt = imageBrief('ingredient', input, ingredient.id, 'Show the walnut texture.');
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
  assert.equal(ingredientStudioBackgroundHex, '#FAF8F2');
  assert.equal(css.match(/--paper\s*:\s*(#[a-f0-9]{6})/i)?.[1].toUpperCase(), ingredientStudioBackgroundHex);
  assert.match(prompt, /studio product photograph.*Walnuts/);
  assert.match(prompt, /Required ingredient form: ground/);
  assert.match(prompt, /exact solid site paper colour #FAF8F2 \(sRGB RGB 250, 248, 242\)/);
  assert.match(prompt, /All unshadowed background areas and all four corners must match/);
  assert.match(prompt, /natural soft contact shadow/);
  assert.match(prompt, /full contact shadow remain inside the frame/);
  assert.doesNotMatch(prompt, /#FFFFFF|Pure white|clear white margins|A cooked dinner with sauce|warm ivory|Reference image|fully transparent background|Add to the finished dish later/);
});

test('captured legacy and white ingredient prompts remain byte-for-byte unchanged', () => {
  // These hashes were captured before adding v3. Accepted jobs retain their
  // original direction even when new jobs default to the site paper colour.
  // Freeze the captured note: the live seed later clarified base-recipe rennet.
  const captured = (input: EditorialContent) => {
    const cheese = input.recipe.ingredients.find(item => item.id === 'cheese')!;
    cheese.note = { ...cheese.note!, en: 'For a vegetarian version, choose a cheese made with vegetarian rennet.' };
    return input;
  };
  const hash = (input: EditorialContent) => createHash('sha256').update(imageBrief('ingredient', input, 'cheese', 'Product texture')).digest('hex');
  const legacyHash = '3e8827a0dc78eb4c654708e789032e3bf7f20e21e15bb3c26b1d83e2acd32295';
  assert.equal(hash(captured(original())), legacyHash);
  assert.equal(hash(captured(studioIngredientInput(ingredientStyleProfile))), legacyHash);
  assert.equal(hash(captured(studioIngredientInput(`${paperIngredientStyleProfile} `))), legacyHash);
  assert.equal(hash(captured(studioIngredientInput())), 'b651da7d512531003c8e1a97a763ab278f2736a01460724be2f02751446b67a2');
});

test('step photography separates the cooked stage from additions in later methods', () => {
  const input = original();
  const ingredient = input.recipe.ingredients[0];
  input.recipe.ingredients = [
    { ...ingredient, id: 'orzo', name: { pl: 'Orzo', en: 'Orzo' }, amount: { kind: 'exact', value: '100' }, unit: 'g' },
    { ...ingredient, id: 'cream', name: { pl: 'Śmietanka', en: 'Single cream' }, amount: { kind: 'exact', value: '50' }, unit: 'ml' },
    { ...ingredient, id: 'spinach', name: { pl: 'Szpinak', en: 'Spinach' }, amount: { kind: 'exact', value: '100' }, unit: 'g' },
  ];
  input.recipe.steps = [
    { id: 'cook-chicken', title: { pl: 'Ugotuj kurczaka', en: 'Cook the chicken' }, text: { pl: 'Ugotuj kurczaka w bulionie.', en: 'Cook the chicken in the broth.' } },
    { id: 'cook-orzo', title: { pl: 'Ugotuj orzo', en: 'Cook the orzo' }, text: { pl: 'Dodaj {{orzo}} orzo i gotuj do miękkości.', en: 'Add {{orzo}} of orzo and simmer until tender.' } },
    { id: 'finish-soup', title: { pl: 'Dodaj śmietankę i szpinak', en: 'Add cream and spinach' }, text: { pl: 'Dodaj {{cream}} śmietanki i {{spinach}} szpinaku.', en: 'Add {{cream}} of single cream and {{spinach}} of spinach.' } },
  ];
  const prompt = imageBrief('step', input, 'cook-orzo', 'Show the tender pasta in broth.');
  const previous = prompt.slice(prompt.indexOf('Earlier steps already completed:'), prompt.indexOf('Current step'));
  const current = prompt.slice(prompt.indexOf('Current step'), prompt.indexOf('Later steps NOT performed yet:'));
  const future = prompt.slice(prompt.indexOf('Later steps NOT performed yet:'), prompt.indexOf('Stage boundary:'));
  assert.match(previous, /Cook the chicken in the broth/);
  assert.match(current, /Current step 2 of 3/);
  assert.match(current, /100 g of orzo and simmer until tender/);
  assert.doesNotMatch(current, /cream|spinach/i);
  assert.match(future, /50 ml of single cream and 100 g of spinach/);
  assert.match(prompt, /later steps are exclusion context/);
  assert.match(prompt, /finished-dish photograph is not supplied as an image reference/);
  assert.doesNotMatch(prompt, /\{\{[^}]+\}\}/);
  assert(Buffer.byteLength(prompt, 'utf8') <= 8_000);
  input.recipe.steps[2].text.en += ' Detailed later-stage instruction.'.repeat(1_100);
  assert.throws(() => imageBrief('step', input, 'cook-orzo', 'Show the pasta.'), code('AI_INPUT_TOO_LARGE'));
});

test('fal paid submission succeeds with exactly one POST and the approved image contract', async t => {
  await withCredentials(async () => {
    let posts = 0; let checks = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = networkGuard(url, init); assert.equal(request.method, 'POST'); posts++;
      assert.equal(init?.redirect, 'error');
      assert.equal(checks, 1);
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.image_size, { width: 2560, height: 1920 });
      assert.equal(body.quality, 'xhigh'); assert.equal(body.num_images, 1); assert.equal(body.background, 'transparent'); assert.equal(body.sync_mode, false);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('X-Fal-No-Retry'), '1'); assert.equal(headers.get('x-app-fal-disable-fallback'), 'true');
      return Response.json({ request_id: 'fake-fal-request' });
    });
    assert.equal(await submitImage(imageModel, 'hero', original(), null, 'Apetyczny kadr', async () => { checks++; }), 'fake-fal-request');
    assert.equal(posts, 1);
  });
});

test('step generation requests a real 21:9 opaque photograph without reading or editing a finished hero', async t => {
  assert.deepEqual(imageSize('hero'), { width: 2560, height: 1920 });
  assert.deepEqual(imageSize('ingredient'), { width: 1024, height: 1024 });
  assert.deepEqual(imageSize('step'), { width: 2240, height: 960 });
  await withCredentials(async () => {
    const input = original(); input.recipe.image = '/media/unavailable-finished-hero';
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'POST'); posts++;
      assert.equal(String(url), `https://queue.fal.run/${imageModel}`);
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.image_size, { width: 2240, height: 960 });
      assert.equal(body.image_size.width * 3, body.image_size.height * 7);
      assert.equal(body.quality, 'high'); assert.equal(body.background, 'opaque'); assert.equal(body.output_format, 'png'); assert.equal(body.num_images, 1);
      assert.equal('image_urls' in body, false);
      return Response.json({ request_id: 'fake-wide-step' });
    });
    assert.equal(await submitImage(imageModel, 'step', input, 'sauce', 'Pokaż konsystencję'), 'fake-wide-step');
    assert.equal(posts, 1);
  });
});

test('captured white and paper ingredient submissions stay at 1024 square high opaque without hero reads or edits', async t => {
  await withCredentials(async () => {
    for (const profile of [whiteIngredientStyleProfile, paperIngredientStyleProfile]) {
      const input = studioIngredientInput(profile); input.recipe.image = '/media/unavailable-hero';
      let posts = 0; let checks = 0;
      t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = networkGuard(url, init);
        assert.equal(request.method, 'POST'); assert.equal(String(url), `https://queue.fal.run/${imageModel}`);
        posts++; assert.equal(checks, 1);
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.image_size, { width: 1024, height: 1024 });
        assert.equal(body.quality, 'high'); assert.equal(body.num_images, 1); assert.equal(body.background, 'opaque');
        assert.equal(body.output_format, 'png'); assert.equal(body.sync_mode, false); assert.equal('image_urls' in body, false);
        assert(Buffer.byteLength(body.prompt, 'utf8') <= 8_000);
        assert.match(body.prompt, /studio product photograph/);
        assert(body.prompt.includes(profile === paperIngredientStyleProfile ? '#FAF8F2' : '#FFFFFF'));
        return Response.json({ request_id: 'fake-white-ingredient' });
      });
      assert.equal(await submitImage(imageModel, 'ingredient', input, 'cheese', 'Product texture', async () => { checks++; }), 'fake-white-ingredient');
      assert.equal(posts, 1);
    }
  });
});

test('white and paper ingredient cutout and oversized prompts fail before any paid submission', async t => {
  await withCredentials(async () => {
    let calls = 0; let checks = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; assert.fail('Rejected studio image actions cannot contact a provider.'); });
    const beforeSubmit = async () => { checks++; };
    for (const profile of [whiteIngredientStyleProfile, paperIngredientStyleProfile]) {
      const input = studioIngredientInput(profile);
      await assert.rejects(submitImage(heroCutoutModel, 'ingredient', input, 'cheese', '', beforeSubmit), code('AI_ACTION_NOT_SUPPORTED'));
      await assert.rejects(submitImage(imageModel, 'ingredient', input, 'cheese', 'ą'.repeat(32_001), beforeSubmit), code('AI_INPUT_TOO_LARGE'));
    }
    assert.equal(calls, 0); assert.equal(checks, 0);
  });
});

test('white and paper polling keeps the entire opaque product, exact background, contact shadow and original pixels', async t => {
  await withCredentials(async () => {
    for (const profile of [whiteIngredientStyleProfile, paperIngredientStyleProfile]) {
      const width = 1024; const height = 1024;
      const pixels = await sharp({ create: { width, height, channels: 3, background: profile === paperIngredientStyleProfile ? '#FAF8F2' : '#FFFFFF' } }).raw().toBuffer();
      for (let y = 400; y < 650; y++) for (let x = 300; x < 700; x++) {
        const offset = (y * width + x) * 3; pixels[offset] = 200; pixels[offset + 1] = 30; pixels[offset + 2] = 10;
      }
      for (let y = 650; y < 710; y++) for (let x = 350; x < 750; x++) {
        const offset = (y * width + x) * 3; pixels.fill(225, offset, offset + 3);
      }
      const originalImage = sharp(pixels, { raw: { width, height, channels: 3 } });
      const samples = [await originalImage.clone().png().toBuffer(), await originalImage.clone().ensureAlpha().png().toBuffer()];
      for (const png of samples) {
        const storage = isolatedImageStorage(); const requests: string[] = []; let terminal = 0;
        const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
          const href = String(url instanceof Request ? url.url : url); requests.push(href);
          assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET'); assert.doesNotMatch(href, /sam-3/);
          if (href === 'https://fal.media/files/studio-product.png') return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
          const request = networkGuard(url, init);
          if (request.href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
          if (request.href.startsWith('https://queue.fal.run/')) return Response.json({ images: [{ url: 'https://fal.media/files/studio-product.png' }] });
          return Response.json({ billing_events: [], has_more: false });
        });
        try {
          const result = await storage.poll(imageModel, 'fake-white-receipt', 'fake-white-job', 'ingredient', studioIngredientInput(profile), 'cheese', async () => { terminal++; });
          assert.equal(result.done, true); if (!result.done) assert.fail('A completed studio image must be saved.');
          assert.equal(result.asset.hasTransparency, false); assert.equal(result.asset.styleProfile, profile);
          assert.equal(result.asset.width, width); assert.equal(result.asset.height, height); assert.equal(terminal, 1);
          assert.equal(storage.saved.size, 1);
          assert.equal(result.asset.originalBlobPathname, result.asset.blobPathname);
          const web = storage.saved.get(result.asset.blobPathname)!;
          assert.deepEqual(await sharp(web).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer());
          const metadata = await sharp(web).metadata(); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
          assert.deepEqual(await sharp(web).removeAlpha().raw().toBuffer(), pixels, 'Product, exact captured background and soft shadow pixels stay unchanged.');
          if (metadata.hasAlpha) assert.equal((await sharp(web).stats()).channels.at(-1)?.min, 255);
          assert.match(result.notes.join(' '), /naturalny cień, bez wycinania tła/);
          assert.match(result.notes.join(' '), profile === paperIngredientStyleProfile ? /#FAF8F2/ : /białym tle/);
          assert.doesNotMatch(result.notes.join(' '), /Sprawdź przezroczystość/);
          assert.equal(requests.length, 4);
        } finally { mock.mock.restore(); }
      }
    }
  });
});

test('an exact completed private backup formats the same accepted photo with no Fal credentials or provider network calls', async t => {
  const oldKeys = Object.fromEntries(['FAL_KEY', 'FAL_API_KEY', 'FAL_BILLING_KEY'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(oldKeys)) delete process.env[key];
  const pixels = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#FAF8F2' } }).raw().toBuffer();
  for (let y = 250; y < 750; y++) for (let x = 350; x < 650; x++) pixels[(y * 1024 + x) * 3] = 180;
  const backup = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } }).webp({ lossless: true, exact: true }).toBuffer();
  const storage = isolatedImageStorage(undefined, {}, undefined, backup);
  const mock = t.mock.method(globalThis, 'fetch', async () => assert.fail('Exact backup recovery cannot call Fal, download another image, or request billing.'));
  try {
    const result = await storage.poll(approvedImageModel, 'known-accepted-receipt', 'same-original-job', 'ingredient', studioIngredientInput(paperIngredientStyleProfile), 'cheese');
    assert(result.done); assert.equal(result.asset.blobPathname, 'ai/same-original-job/original-v1.webp');
    assert.equal(storage.saved.size, 1); assert.equal(Object.keys(result.cost).length, 0);
    assert.deepEqual(await sharp(storage.saved.get(result.asset.blobPathname)!).removeAlpha().raw().toBuffer(), pixels);
  } finally { mock.mock.restore(); for (const [key, value] of Object.entries(oldKeys)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('opaque legacy ingredient and hero results still require their captured transparency contract', async t => {
  await withCredentials(async () => {
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer();
    for (const [kind, input] of [['ingredient', original()], ['hero', studioIngredientInput()], ['hero', studioIngredientInput(paperIngredientStyleProfile)]] as const) {
      const storage = isolatedImageStorage();
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url instanceof Request ? url.url : url); assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
        if (href === 'https://fal.media/files/opaque-old.png') return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
        networkGuard(url, init);
        return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ images: [{ url: 'https://fal.media/files/opaque-old.png' }] });
      });
      try {
        await assert.rejects(storage.poll(imageModel, 'fake-old-receipt', 'fake-old-job', kind, input, kind === 'ingredient' ? 'cheese' : null), code('AI_TRANSPARENCY_MISSING'));
        assert.equal(storage.saved.size, 1);
        const retained = storage.saved.get('ai/fake-old-job/recovered-original.webp');
        assert(retained, 'Rejected transparency still retains the accepted photograph.');
        assert.deepEqual(await sharp(retained).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer());
      } finally { mock.mock.restore(); }
    }
    assert.equal(ingredientStyleProfile, 'jesie-ingredient-editorial-v1');
  });
});

test('a transparency-rejected manual hero is retained losslessly and recovered without a new provider request', async t => {
  await withCredentials(async () => {
    const source = recoverableHeroSource();
    const input = currentHeroInput('clay-pot'); input.recipe.id = source.recipeId; input.aiPhotography = { ...input.aiPhotography, regenerate: true, heroRetakeVersion: 'vessel-cutout-v1' };
    const opaque = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#a87c45' } }).png().toBuffer();
    const partialPixels = await sharp(opaque).ensureAlpha(0.5).raw().toBuffer();
    partialPixels[3] = 0; // Hidden RGB must survive in the exact retained source as well.
    const partial = await sharp(partialPixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
    for (const png of [opaque, partial]) {
      const requests: string[] = []; const storage = isolatedImageStorage(); let terminal = 0;
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url instanceof Request ? url.url : url); requests.push(href);
        assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET', 'Neither validation nor retention can submit generation or SAM.');
        assert.doesNotMatch(href, /sam-3/);
        if (href === 'https://fal.media/files/accepted-manual-hero.png') return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
        return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ images: [{ url: 'https://fal.media/files/accepted-manual-hero.png' }] });
      });
      try {
        await assert.rejects(storage.poll(imageModel, source.providerRequestId!, source.id, 'hero', input, null, async () => { terminal++; }), error => {
          assert(error instanceof ProviderError); assert.equal(error.code, 'AI_TRANSPARENCY_MISSING');
          assert.match(error.message, /Fotografia powstała i została zachowana/); return true;
        });
        assert.equal(terminal, 1); assert.equal(storage.saved.size, 1);
        const path = `ai/${source.id}/recovered-original.webp`;
        const retained = storage.saved.get(path)!;
        assert.deepEqual(await sharp(retained).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer());
        const count = requests.length;
        const recovered = await storage.recover({ ...source, input }, source.recipeId);
        assert.equal(requests.length, count, 'Recovery must use the retained photo even if the provider URL expires.');
        assert.deepEqual(await sharp(recovered).removeAlpha().raw().toBuffer(), await sharp(png).removeAlpha().raw().toBuffer());
        assert.equal(storage.saved.size, 1, 'Recovery reuses the accepted source rather than making another copy.');
      } finally { mock.mock.restore(); }
    }
  });
});

test('a manual hero with transparent surroundings and near-opaque food is saved without requesting a mask', async t => {
  await withCredentials(async () => {
    const width = 1024, height = 1024;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = x % 256; pixels[offset + 1] = y % 256; pixels[offset + 2] = 117;
      const food = x >= 200 && x < 750 && y >= 250 && y < 750;
      const utensil = x >= 800 && x < 830 && y >= 300 && y < 700;
      pixels[offset + 3] = food || utensil ? 250 + (x + y) % 5 : x === 199 && y >= 250 && y < 750 ? 127 : 0;
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const storage = isolatedImageStorage();
    const input = currentHeroInput('sauceboat'); input.aiPhotography!.regenerate = true;
    let terminal = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal(init?.method ?? (url instanceof Request ? url.method : 'GET'), 'GET', 'An already generated cutout cannot trigger a paid generation or mask.');
      assert.doesNotMatch(href, /sam-3/);
      if (href === 'https://fal.media/files/near-opaque-manual-hero.png') return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
      const request = networkGuard(url, init);
      if (request.href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (request.href.startsWith('https://queue.fal.run/')) return Response.json({ images: [{ url: 'https://fal.media/files/near-opaque-manual-hero.png' }] });
      return Response.json({ billing_events: [], has_more: false });
    });
    const result = await storage.poll(imageModel, 'fake-near-opaque-receipt', 'near-opaque-manual-hero', 'hero', input, null, async () => { terminal++; });
    assert(result.done, 'A valid near-opaque interior must yield a ready photo instead of a transparency failure.');
    assert.equal(terminal, 1); assert.equal(result.asset.hasTransparency, true);
    assert.deepEqual(await sharp(storage.saved.get(result.asset.originalBlobPathname)!).ensureAlpha().raw().toBuffer(), pixels,
      'The exact accepted photo, including detached utensils, soft edges and near-opaque alpha, is retained.');
    assert(!storage.saved.has('ai/near-opaque-manual-hero/recovered-original.webp'));
  });
});

test('new manual compositions preserve an opaque complete photograph as a ready proposal without segmentation', async t => {
  await withCredentials(async () => {
    for (const version of [undefined, 'complete-composition-v1'] as const) {
    const input = currentHeroInput('sauceboat');
    input.aiPhotography = { ...input.aiPhotography, regenerate: true, ...(version ? { heroRetakeVersion: version } : {}) };
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#a87c45' } }).png().toBuffer();
    const storage = isolatedImageStorage(undefined, {}, undefined, png);
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      assert.match(href, /^https:\/\/api\.fal\.ai\/v1\/models\/billing-events/);
      return Response.json({ billing_events: [], has_more: false });
    });
    const result = await storage.poll(imageModel, 'fake-composition-receipt', 'complete-composition', 'hero', input, null);
    assert(result.done); assert.equal(result.asset.hasTransparency, false);
    assert.match(result.notes.join(' '), /pełny kadr bez automatycznego wycinania/);
    assert.equal(storage.saved.size, 1, 'The lossless archive and display image share the same bytes.');
    assert.deepEqual(await sharp(storage.saved.get(result.asset.blobPathname)!).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer());
    assert(!storage.saved.has('ai/complete-composition/recovered-original.webp'));
    }
  });
});

test('standard manual retakes retain opaque results for cutout rather than applying the complete-frame fallback', async t => {
  await withCredentials(async () => {
    const input = currentHeroInput('plate');
    input.aiPhotography = { ...input.aiPhotography, regenerate: true, heroRetakeVersion: 'vessel-cutout-v1' };
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#a87c45' } }).png().toBuffer();
    const storage = isolatedImageStorage(undefined, {}, undefined, png);
    t.mock.method(globalThis, 'fetch', async () => assert.fail('Retaining an accepted result cannot buy another image or mask.'));
    await assert.rejects(storage.poll(imageModel, 'standard-retake-receipt', 'standard-retake', 'hero', input, null), code('AI_TRANSPARENCY_MISSING'));
    assert.equal(storage.saved.size, 1);
    const retained = storage.saved.get('ai/standard-retake/recovered-original.webp')!;
    assert.deepEqual(await sharp(retained).ensureAlpha().raw().toBuffer(), await sharp(png).ensureAlpha().raw().toBuffer());
  });
});

test('ordinary ceramic heroes normalize negligible alpha residue before validation without buying a mask', async t => {
  await withCredentials(async () => {
    const width=1024,height=1024;
    const pixels=Buffer.alloc(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const offset=(y*width+x)*4;
      pixels[offset]=x%256;pixels[offset+1]=y%256;pixels[offset+2]=90;
      pixels[offset+3]=x>=200&&x<824&&y>=200&&y<824?252:x===199&&y>=200&&y<824?100:1;
    }
    const png=await sharp(pixels,{raw:{width,height,channels:4}}).png().toBuffer();
    const input=currentHeroInput('plate');
    input.aiPhotography={...input.aiPhotography,regenerate:true,heroRetakeVersion:'vessel-cutout-v1'};
    const storage=isolatedImageStorage(undefined,{},undefined,png);
    t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
      assert.equal((init?.method??'GET').toUpperCase(),'GET');
      assert.match(String(url),/^https:\/\/api\.fal\.ai\/v1\/models\/billing-events/);
      return Response.json({billing_events:[],has_more:false});
    });
    const result=await storage.poll(imageModel,'alpha-residue-receipt','standard-alpha-residue','hero',input,null);
    assert(result.done);assert.equal(result.asset.hasTransparency,true);
    const output=await sharp(storage.saved.get(result.asset.blobPathname)!).ensureAlpha().raw().toBuffer();
    assert.equal(output[3],0);assert.equal(output[(500*width+500)*4+3],255);assert.equal(output[(500*width+199)*4+3],100);
    for(let pixel=0;pixel<width*height;pixel++)assert.deepEqual(output.subarray(pixel*4,pixel*4+3),pixels.subarray(pixel*4,pixel*4+3));
    assert.deepEqual(await sharp(storage.saved.get(result.asset.originalBlobPathname)!).ensureAlpha().raw().toBuffer(),pixels,'The exact accepted original remains available.');
    assert(!storage.saved.has('ai/standard-alpha-residue/recovered-original.webp'));
  });
});

test('generated glass heroes with erased contents retain the original and never save a complete-dish asset', async t => {
  await withCredentials(async () => {
    const width = 1024, height = 1024;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const bowl = x >= 200 && x < 824 && y >= 100 && y < 700;
      const stem = x >= 475 && x < 549 && y >= 700 && y < 900;
      const foot = x >= 350 && x < 674 && y >= 900 && y < 924;
      const erasedFood = x >= 300 && x < 724 && y >= 200 && y < 500;
      pixels.set([190, 210, 200, (bowl || stem || foot) && !erasedFood ? 255 : 0], (y * width + x) * 4);
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const storage = isolatedImageStorage(undefined, {}, undefined, png);
    t.mock.method(globalThis, 'fetch', async () => assert.fail('A retained completed image needs no new provider request.'));
    await assert.rejects(storage.poll(imageModel, 'erased-glass-receipt', 'erased-glass', 'hero', currentHeroInput('glass'), null), code('AI_TRANSPARENCY_MISSING'));
    assert(!storage.saved.has('ai/erased-glass/web-v1.webp'));
    assert.deepEqual(await sharp(storage.saved.get('ai/erased-glass/recovered-original.webp')!).ensureAlpha().raw().toBuffer(), pixels);
  });
});

test('generated drinking-glass heroes retain intentional low alpha instead of solid-vessel normalization or filling', async t => {
  await withCredentials(async () => {
    const width = 1024, height = 1024;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 100; y < 924; y++) for (let x = 150; x < 874; x++) {
      const offset = (y * width + x) * 4;
      pixels.set([190, 210, 200, y >= 600 && y < 780 && x >= 220 && x < 804 ? 255 : 120], offset);
    }
    pixels[(200 * width + 500) * 4 + 3] = 5;
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const storage = isolatedImageStorage(undefined, {}, undefined, png);
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      assert.match(String(url), /^https:\/\/api\.fal\.ai\/v1\/models\/billing-events/);
      return Response.json({ billing_events: [], has_more: false });
    });
    const result = await storage.poll(imageModel, 'glass-alpha-receipt', 'glass-alpha', 'hero', currentHeroInput('glass'), null);
    assert(result.done); assert.equal(result.asset.hasTransparency, true);
    const output = await sharp(storage.saved.get(result.asset.blobPathname)!).ensureAlpha().raw().toBuffer();
    assert.equal(output[(200 * width + 500) * 4 + 3], 5);
    assert.equal(output[(500 * width + 500) * 4 + 3], 120);
    assert.equal(output[(700 * width + 500) * 4 + 3], 255);
    assert(!storage.saved.has('ai/glass-alpha/recovered-original.webp'));
  });
});

async function cornerHandleHeroFixture() {
  const width = 1024, height = 1024;
  const pixels = Buffer.alloc(width * height * 4);
  const normalized = Buffer.alloc(pixels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const body = x >= 120 && x < 880 && y >= 140 && y < 900;
    const handle = x >= 800 && y <= 240 && x + y >= 1000 && x + y <= 1040;
    const aperture = x >= 250 && x < 270 && y >= 340 && y < 370;
    const offset = (y * width + x) * 4;
    pixels.set([x % 256, y % 256, (x + y) % 256, (body || handle) && !aperture ? 252 : 1], offset);
    normalized.set(pixels.subarray(offset, offset + 4), offset);
    normalized[offset + 3] = (body || handle) && !aperture ? 255 : 0;
  }
  return { width, height, pixels, normalized, png: await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer() };
}

async function assertPaddedHeroPreservesFrame(bytes: Buffer, fixture: Awaited<ReturnType<typeof cornerHandleHeroFixture>>) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert(info.width > fixture.width && info.height > fixture.height, 'Existing handle pixels get empty canvas rather than being erased.');
  const left = (info.width - fixture.width) / 2, top = (info.height - fixture.height) / 2;
  assert(Number.isSafeInteger(left) && left > 0 && Number.isSafeInteger(top) && top > 0);
  const preserved = await sharp(bytes).extract({ left, top, width: fixture.width, height: fixture.height }).ensureAlpha().raw().toBuffer();
  assert.deepEqual(preserved, fixture.normalized, 'Every source RGB, food pixel and genuine aperture remains unchanged apart from alpha endpoint cleanup.');
  for (const pixel of [0, info.width - 1, (info.height - 1) * info.width, info.width * info.height - 1]) assert.equal(data[pixel * 4 + 3], 0);
  await validateSolidHeroCutout(bytes);
}

test('a generated pan handle reaching one corner becomes a ready complete hero without buying SAM', async t => {
  await withCredentials(async () => {
    const fixture = await cornerHandleHeroFixture();
    const storage = isolatedImageStorage(undefined, {}, undefined, fixture.png);
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      const href = String(url instanceof Request ? url.url : url); requests.push(href);
      assert.match(href, /^https:\/\/api\.fal\.ai\/v1\/models\/billing-events/);
      return Response.json({ billing_events: [], has_more: false });
    });
    const result = await storage.poll(imageModel, 'accepted-pan-receipt', 'pan-corner-job', 'hero', currentHeroInput('pan'), null);
    assert(result.done); assert.equal(result.asset.hasTransparency, true);
    await assertPaddedHeroPreservesFrame(storage.saved.get(result.asset.blobPathname)!, fixture);
    assert.deepEqual(await sharp(storage.saved.get(result.asset.originalBlobPathname)!).ensureAlpha().raw().toBuffer(), fixture.pixels);
    assert(!storage.saved.has('ai/pan-corner-job/recovered-original.webp'), 'A valid completed photograph never enters failed-cutout recovery.');
    assert.equal(requests.length, 1);
  });
});

test('a failed SAM receipt restores the exact retained hero alpha while preserving its source and mask without paid calls', async t => {
  await withCredentials(async () => {
    const fixture = await cornerHandleHeroFixture();
    const sourceId = 'ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    const sourceInput = currentHeroInput('pan');
    const input = structuredClone(sourceInput); input.recipe.image = `/ai-result/${sourceId}`;
    const storage = isolatedImageStorage(fixture.png, { id: sourceId, model: approvedImageModel, status: 'failed', providerRequestId: 'accepted-original-pan', errorCode: 'AI_TRANSPARENCY_MISSING', result: null, appliedRevision: null, input: sourceInput });
    const sourcePath = `ai/${sourceId}/recovered-original.webp`;
    const maskPath = 'ai/failed-pan-mask/accepted-mask-v1';
    const retainedSource = await sharp(fixture.png).webp({ lossless: true, exact: true }).toBuffer();
    const rejectedMask = await sharp(Buffer.alloc(fixture.width * fixture.height), { raw: { width: fixture.width, height: fixture.height, channels: 1 } }).png().toBuffer();
    storage.saved.set(sourcePath, retainedSource); storage.saved.set(maskPath, rejectedMask);
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET', 'Recovery cannot buy another photograph or segmentation request.');
      const request = new URL(String(url instanceof Request ? url.url : url)); requests.push(request.href);
      assert.equal(request.hostname, 'api.fal.ai', 'The retained photograph must recover even when its expired SAM result cannot be fetched.');
      assert.equal(request.pathname, '/v1/models/billing-events');
      assert.equal(request.searchParams.get('request_id'), 'accepted-failed-pan-mask', 'Accounting keeps the original accepted SAM receipt.');
      return Response.json({ billing_events: [], has_more: false });
    });
    const result = await storage.poll(heroCutoutModel, 'accepted-failed-pan-mask', 'failed-pan-mask', 'hero', input, null);
    assert(result.done); assert.equal(result.asset.hasTransparency, true);
    await assertPaddedHeroPreservesFrame(storage.saved.get(result.asset.blobPathname)!, fixture);
    assert.deepEqual(storage.saved.get(sourcePath), retainedSource, 'The original accepted photograph stays immutable.');
    assert.deepEqual(storage.saved.get(maskPath), rejectedMask, 'Recovery never rewrites the existing failed SAM evidence.');
    assert.equal(requests.length, 1);
  });
});

async function completeAndVesselOnlyHeroMasks() {
  const width = 120, height = 100;
  const source = await sharp({ create: { width, height, channels: 3, background: '#b7783c' } }).png().toBuffer();
  const masks: Record<string, Buffer> = {};
  for (const complete of [false, true]) {
    const alpha = Buffer.alloc(width * height);
    for (let y = 20; y < 90; y++) for (let x = 25; x < 95; x++) alpha[y * width + x] = 255;
    if (!complete) {
      for (let y = 30; y < 65; y++) for (let x = 40; x < 80; x++) alpha[y * width + x] = 0;
      for (let y = 20; y <= 30; y++) alpha[y * width + 60] = 0;
    }
    masks[complete ? 'complete' : 'vessel-only'] = await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
  }
  return { source, masks };
}

test('SAM polling chooses a locally complete lower-scored candidate and replays its exact accepted mask without provider reads', async t => {
  await withCredentials(async () => {
    const { source, masks } = await completeAndVesselOnlyHeroMasks();
    const input = currentHeroInput('pan'); input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    const storage = isolatedImageStorage(source);
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url); requests.push(href);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      for (const name of ['vessel-only', 'complete']) if (href === `https://fal.media/files/${name}.png`) return new Response(new Uint8Array(masks[name]), { headers: { 'Content-Type': 'image/png' } });
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (href.startsWith('https://queue.fal.run/')) return Response.json({ masks: [{ url: 'https://fal.media/files/vessel-only.png' }, { url: 'https://fal.media/files/complete.png' }], scores: [0.99, 0.7] });
      assert.match(href, /^https:\/\/api\.fal\.ai\/v1\/models\/billing-events/);
      return Response.json({ billing_events: [], has_more: false });
    });
    const result = await storage.poll(heroCutoutModel, 'accepted-multiple-masks', 'complete-mask-choice', 'hero', input, null);
    assert(result.done); assert.equal(result.asset.hasTransparency, true);
    assert.deepEqual(storage.saved.get('ai/complete-mask-choice/accepted-mask-v1'), masks['vessel-only'], 'The original highest-ranked accepted mask remains immutable evidence.');
    assert.deepEqual(storage.saved.get('ai/complete-mask-choice/accepted-mask-v2'), masks.complete, 'The validated lower-ranked mask is retained separately for replay.');
    await validateSolidHeroCutout(storage.saved.get(result.asset.blobPathname)!);
    assert.equal(requests.filter(href => href === 'https://fal.media/files/vessel-only.png').length, 1);
    assert.equal(requests.filter(href => href === 'https://fal.media/files/complete.png').length, 1);
    const providerReads = requests.filter(href => !href.startsWith('https://api.fal.ai/')).length;
    assert((await storage.poll(heroCutoutModel, 'accepted-multiple-masks', 'complete-mask-choice', 'hero', input, null)).done);
    assert.equal(requests.filter(href => !href.startsWith('https://api.fal.ai/')).length, providerReads, 'Replay uses the validated immutable mask without queue, CDN or paid submission calls.');
  });
});

test('a temporary lower-mask download resumes the same accepted candidates after the queue response expires', async t => {
  await withCredentials(async () => {
    const { source, masks } = await completeAndVesselOnlyHeroMasks();
    const input = currentHeroInput('pan'); input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    const storage = isolatedImageStorage(source);
    let resumed = false;
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url); requests.push(href);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET', 'An existing paid receipt can only be read.');
      if (href === 'https://fal.media/files/vessel-only.png') {
        assert.equal(resumed, false, 'The already retained rejected mask must not be downloaded again.');
        return new Response(new Uint8Array(masks['vessel-only']), { headers: { 'Content-Type': 'image/png' } });
      }
      if (href === 'https://fal.media/files/complete.png') return resumed
        ? new Response(new Uint8Array(masks.complete), { headers: { 'Content-Type': 'image/png' } })
        : new Response('Temporary CDN failure', { status: 503 });
      if (href.startsWith('https://queue.fal.run/')) {
        assert.equal(resumed, false, 'Recovery uses the retained response manifest even when the remote result has expired.');
        return href.includes('/status?') ? Response.json({ status: 'COMPLETED' })
          : Response.json({ masks: [{ url: 'https://fal.media/files/vessel-only.png' }, { url: 'https://fal.media/files/complete.png' }], scores: [0.99, 0.7] });
      }
      assert.match(href, /^https:\/\/api\.fal\.ai\/v1\/models\/billing-events/);
      return Response.json({ billing_events: [], has_more: false });
    });
    await assert.rejects(storage.poll(heroCutoutModel, 'accepted-transient-candidates', 'transient-mask-choice', 'hero', input, null), code('AI_IMAGE_DOWNLOAD_UNAVAILABLE', true));
    const manifestPath = 'ai/transient-mask-choice/accepted-mask-candidates-v1.json';
    const immutableManifest = storage.saved.get(manifestPath)!;
    assert(immutableManifest, 'The accepted response survives a partial candidate download.');
    assert.deepEqual(storage.saved.get('ai/transient-mask-choice/accepted-mask-v1'), masks['vessel-only']);
    assert(!storage.saved.has('ai/transient-mask-choice/web-v1.webp'));
    resumed = true;
    const result = await storage.poll(heroCutoutModel, 'accepted-transient-candidates', 'transient-mask-choice', 'hero', input, null);
    assert(result.done); await validateSolidHeroCutout(storage.saved.get(result.asset.blobPathname)!);
    assert.deepEqual(storage.saved.get(manifestPath), immutableManifest);
    assert.deepEqual(storage.saved.get('ai/transient-mask-choice/accepted-mask-v1'), masks['vessel-only']);
    assert.deepEqual(storage.saved.get('ai/transient-mask-choice/accepted-mask-v2'), masks.complete);
    assert.equal(requests.filter(href => href === 'https://fal.media/files/complete.png').length, 2, 'Only the missing accepted mask GET is retried.');
    assert.equal(requests.filter(href => href.startsWith('https://queue.fal.run/')).length, 2);
  });
});

test('new manual compositions reject invisible images rather than returning an empty ready proposal', async t => {
  await withCredentials(async () => {
    const input = currentHeroInput(); input.aiPhotography = { ...input.aiPhotography, regenerate: true, heroRetakeVersion: 'complete-composition-v1' };
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 180, g: 140, b: 80, alpha: 0 } } }).png().toBuffer();
    const storage = isolatedImageStorage(undefined, {}, undefined, png);
    t.mock.method(globalThis, 'fetch', async () => assert.fail('An invalid retained image cannot start another provider request.'));
    await assert.rejects(storage.poll(imageModel, 'fake-empty-receipt', 'empty-composition', 'hero', input, null), code('AI_IMAGE_INVALID'));
    assert.equal(storage.saved.size, 0);
  });
});

test('failed transparency-source retention preserves storage retry and accepted-result uncertainty', async t => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#a87c45' } }).png().toBuffer();
  const input = currentHeroInput('clay-pot'); input.aiPhotography = { ...input.aiPhotography, regenerate: true, heroRetakeVersion: 'vessel-cutout-v1' };
  const mock = t.mock.method(globalThis, 'fetch', async () => assert.fail('A retained provider backup cannot submit or re-fetch an image.'));
  try {
    for (const failure of [new BlobServiceNotAvailable(), new BlobError('Storage quota exceeded')]) {
      const storage = isolatedImageStorage(undefined, {}, undefined, png, { write: failure }); let terminal = 0;
      await assert.rejects(storage.poll(imageModel, 'accepted-receipt', 'accepted-job', 'hero', input, null, async () => { terminal++; }), error => error === failure);
      assert.equal(terminal, 1); assert.equal(storage.saved.size, 0);
      assert.equal(photoResultRecoveryError(failure)?.uncertain, true);
      assert.equal(isTransientPhotoResultRead(failure), failure instanceof BlobServiceNotAvailable);
    }
  } finally { mock.mock.restore(); }
});

test('unexpected cutout errors do not become permanent transparency failures or retained replacements', async t => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#a87c45' } }).png().toBuffer();
  const failure = new Error('Unexpected cutout decoder failure');
  const storage = isolatedImageStorage(undefined, {}, undefined, png, { cutout: failure });
  const mock = t.mock.method(globalThis, 'fetch', async () => assert.fail('No provider request is allowed.'));
  try {
    await assert.rejects(storage.poll(imageModel, 'accepted-receipt', 'accepted-job', 'hero', currentHeroInput('clay-pot'), null), error => error === failure);
    assert.equal(storage.saved.size, 0);
  } finally { mock.mock.restore(); }
});

test('white and paper ingredient polling rejects transparent or undersized results without editing or buying a mask', async t => {
  await withCredentials(async () => {
    const transparent = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
    const small = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer();
    for (const profile of [whiteIngredientStyleProfile, paperIngredientStyleProfile]) for (const png of [transparent, small]) {
      const storage = isolatedImageStorage();
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url instanceof Request ? url.url : url); assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET'); assert.doesNotMatch(href, /sam-3/);
        if (href === 'https://fal.media/files/invalid-studio.png') return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
        networkGuard(url, init);
        return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ images: [{ url: 'https://fal.media/files/invalid-studio.png' }] });
      });
      try {
        await assert.rejects(storage.poll(imageModel, 'fake-invalid-receipt', 'fake-invalid-job', 'ingredient', studioIngredientInput(profile), 'cheese'), code('AI_IMAGE_INVALID'));
        assert.equal(storage.saved.size, 0);
      } finally { mock.mock.restore(); }
    }
  });
});

test('cutout rejects steps and non-recovery ingredients before the paid transport', async t => {
  await withCredentials(async () => {
    let calls = 0; let admitted = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Rejected actions cannot use the network'); });
    const beforeSubmit = async () => { admitted++; };
    await assert.rejects(submitImage(heroCutoutModel, 'step', original(), 'sauce', '', beforeSubmit), code('AI_TARGET_MISSING'));
    await assert.rejects(submitImage(heroCutoutModel, 'ingredient', original(), 'cheese', '', beforeSubmit), code('AI_REFERENCE_UNAVAILABLE'));
    await assert.rejects(submitImage(stepFormatModel, 'step', original(), 'sauce', '', beforeSubmit), code('AI_MODEL_NOT_APPROVED'));
    await assert.rejects(submitImage(filledHeroModel, 'hero', original(), null, '', beforeSubmit), code('AI_MODEL_NOT_APPROVED'));
    const missingHero = original(); missingHero.recipe.image = '';
    await assert.rejects(submitImage(heroCutoutModel, 'hero', missingHero, null, '', beforeSubmit), code('AI_REFERENCE_UNAVAILABLE'));
    assert.equal(calls, 0); assert.equal(admitted, 0);
  });
});

test('local cropping requires both a matching recipe step and its existing photo before any image read', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Invalid crop targets cannot fetch files'); });
  for (const target of [null, 'missing-step']) await assert.rejects(formatExistingStep(original(), target, 'fake-job'), code('AI_TARGET_MISSING'));
  const input = original(); delete input.photos.steps.sauce;
  await assert.rejects(formatExistingStep(input, 'sauce', 'fake-job'), code('AI_TARGET_MISSING'));
  input.photos.steps['missing-step'] = structuredClone(input.photos.steps.pasta);
  await assert.rejects(formatExistingStep(input, 'missing-step', 'fake-job'), code('AI_TARGET_MISSING'));
  assert.equal(calls, 0);
});

test('local vessel repair rejects arbitrary image locations before reading any remote file', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Invalid cutout sources cannot fetch files'); });
  for (const src of ['', '/images/lemon-pasta.webp', 'https://fal.media/untrusted.png', '/media/not-a-uuid', '../outside.png']) {
    const input = original(); input.recipe.image = src;
    await assert.rejects(formatExistingHero(input, 'fake-job'), code('AI_REFERENCE_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
});

test('sauce boat cutouts retain the handle gap and restore sauce while jars and bottles stay unfilled', async t => {
  await withCredentials(async () => {
    const { source, mask, width } = await sauceboatCutoutFixture();
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET', 'Polling and local storage never submit a paid request.');
      if (href === 'https://fal.media/files/glass-mask.png') return new Response(new Uint8Array(mask), { headers: { 'Content-Type': 'image/png' } });
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (href.startsWith('https://queue.fal.run/')) return Response.json({ masks: [{ url: 'https://fal.media/files/glass-mask.png' }], scores: [0.99] });
      return Response.json({ billing_events: [], has_more: false });
    });
    for (const container of ['jar', 'bottle', 'sauceboat', 'plate'] as const) {
      const input = currentHeroInput(container);
      input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
      const storage = isolatedImageStorage(source);
      const result = await storage.poll(heroCutoutModel, 'fake-mask-receipt', `fake-mask-${container}`, 'hero', input, null);
      assert(result.done); if (!result.done) assert.fail('Completed masks must be saved.');
      assert.equal(result.asset.styleProfile, heroPresentationProfile);
      const pixels = await sharp(storage.saved.get(`ai/fake-mask-${container}/web-v1.webp`)!).ensureAlpha().raw().toBuffer();
      assert.equal(pixels[(20 * width + 82) * 4 + 3], container === 'plate' ? 255 : 0, 'The handle is never filled for a sauce boat.');
      assert.equal(pixels[(22 * width + 30) * 4 + 3], container === 'plate' || container === 'sauceboat' ? 255 : 0, 'Sauce must remain visible.');
    }
  });
});

test('glass candidate selection rejects vessel-only masks and retains food with the original wall and stem alpha', async t => {
  await withCredentials(async () => {
    const { source, vesselOnlyMask, completeMask, width } = await glassCutoutFixture();
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url); requests.push(href);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      if (href === 'https://fal.media/files/vessel-only.png') return new Response(new Uint8Array(vesselOnlyMask), { headers: { 'Content-Type': 'image/png' } });
      if (href === 'https://fal.media/files/glass-with-food.png') return new Response(new Uint8Array(completeMask), { headers: { 'Content-Type': 'image/png' } });
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (href.startsWith('https://queue.fal.run/')) return Response.json({ masks: [{ url: 'https://fal.media/files/vessel-only.png' }, { url: 'https://fal.media/files/glass-with-food.png' }], scores: [0.99, 0.8] });
      return Response.json({ billing_events: [], has_more: false });
    });
    const input = currentHeroInput('glass');
    input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    input.aiPhotography!.heroMaskPromptVersion = glassHeroMaskPromptVersion;
    const storage = isolatedImageStorage(source);
    const result = await storage.poll(heroCutoutModel, 'glass-candidates-receipt', 'glass-candidates', 'hero', input, null);
    assert(result.done);
    assert.deepEqual(storage.saved.get('ai/glass-candidates/accepted-mask-v1'), vesselOnlyMask);
    assert.deepEqual(storage.saved.get('ai/glass-candidates/accepted-mask-v2'), completeMask);
    const output = await sharp(storage.saved.get(result.asset.blobPathname)!).ensureAlpha().raw().toBuffer();
    assert.equal(output[(45 * width + 60) * 4 + 3], 255, 'The soup surface and toppings remain visible.');
    assert.equal(output[(20 * width + 20) * 4 + 3], 100, 'The glass wall remains translucent.');
    assert.equal(output[(120 * width + 60) * 4 + 3], 100, 'The glass stem remains translucent.');
    assert.equal(output[3], 0);
    assert.equal(requests.filter(href => href.startsWith('https://fal.media/')).length, 2);
  });
});

test('glass repair never saves a vessel-only mask as a complete finished dish', async t => {
  await withCredentials(async () => {
    const { source, vesselOnlyMask } = await glassCutoutFixture();
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      if (href === 'https://fal.media/files/vessel-only.png') return new Response(new Uint8Array(vesselOnlyMask), { headers: { 'Content-Type': 'image/png' } });
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ masks: [{ url: 'https://fal.media/files/vessel-only.png' }], scores: [0.99] });
    });
    const input = currentHeroInput('glass'); input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    for (const mode of ['poll', 'repair'] as const) {
      const storage = isolatedImageStorage(source);
      await assert.rejects(mode === 'poll'
        ? storage.poll(heroCutoutModel, 'glass-receipt', `bad-glass-${mode}`, 'hero', input, null)
        : storage.repair(input, `bad-glass-${mode}`), code('AI_IMAGE_INVALID'));
      assert(!storage.saved.has(`ai/bad-glass-${mode}/web-v1.webp`));
    }
  });
});

test('handled cookware masks restore enclosed food and preserve both handle gaps, including cached receipt replay', async t => {
  await withCredentials(async () => {
    const width = 120, height = 100;
    const source = await sharp({ create: { width, height, channels: 3, background: '#b7783c' } }).png().toBuffer();
    const alpha = Buffer.alloc(width * height);
    for (let y = 20; y < 90; y++) for (let x = 25; x < 95; x++) alpha[y * width + x] = 255;
    for (let y = 40; y < 65; y++) for (let x = 5; x < 115; x++) {
      if (x < 25 || x >= 95) alpha[y * width + x] = y < 45 || y >= 60 || x < 10 || x >= 110 ? 255 : 0;
    }
    for (let y = 30; y < 58; y++) for (let x = 40; x < 80; x++) alpha[y * width + x] = 0; // SAM selected the pot, omitting its food.
    const mask = await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
    let providerReads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      if (href.startsWith('https://fal.media/') || href.startsWith('https://queue.fal.run/')) providerReads++;
      if (href === 'https://fal.media/files/cookware-mask.png') return new Response(new Uint8Array(mask), { headers: { 'Content-Type': 'image/png' } });
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (href.startsWith('https://queue.fal.run/')) return Response.json({ masks: [{ url: 'https://fal.media/files/cookware-mask.png' }], scores: [0.99] });
      return Response.json({ billing_events: [], has_more: false });
    });
    for (const container of ['clay-pot', 'pot', 'pan', 'baking-dish'] as const) {
      const input = currentHeroInput('plate');
      input.aiPhotography!.heroPresentationOverride = { ...input.recipe.heroPresentation!, container };
      input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
      const storage = isolatedImageStorage(source);
      const result = await storage.poll(heroCutoutModel, 'fake-cookware-receipt', `cookware-${container}`, 'hero', input, null);
      assert(result.done);
      const pixels = await sharp(storage.saved.get(`ai/cookware-${container}/web-v1.webp`)!).ensureAlpha().raw().toBuffer();
      assert.equal(pixels[(50 * width + 15) * 4 + 3], 0);
      assert.equal(pixels[(50 * width + 105) * 4 + 3], 0);
      assert.equal(pixels[(50 * width + 60) * 4 + 3], 255);
      assert.equal(pixels[(42 * width + 15) * 4 + 3], 255);
      assert.deepEqual(storage.saved.get(`ai/cookware-${container}/accepted-mask-v1`), mask, 'The exact paid mask is retained before applying geometry repairs.');
      const readsBeforeReplay = providerReads;
      assert((await storage.poll(heroCutoutModel, 'fake-cookware-receipt', `cookware-${container}`, 'hero', input, null)).done);
      assert.equal(providerReads, readsBeforeReplay, 'Replaying the same accepted receipt uses the immutable raw mask without queue or CDN reads.');
      const savedBeforeInspection = storage.saved.size;
      const inspected = await storage.inspect({ id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', provider: 'fal', model: heroCutoutModel, kind: 'hero', providerRequestId: 'fake-cookware-receipt', input }, true);
      assert.equal(inspected.mediaValidated, true, 'Read-only inspection uses the same conservative cookware repair.');
      assert.equal(storage.saved.size, savedBeforeInspection, 'Inspection writes no source, mask, or output assets.');
      const repaired = await storage.repair(input, `cookware-local-${container}`);
      assert.equal(repaired.cost.chargedUsd, '0.00000000');
      const local = await sharp(storage.saved.get(`ai/cookware-local-${container}/web-v1.webp`)!).ensureAlpha().raw().toBuffer();
      assert.equal(local[(50 * width + 60) * 4 + 3], 255);
      assert.equal(local[(50 * width + 15) * 4 + 3], 0);
    }
  });
});

test('an accepted hero mask survives geometry rejection and repeats from cache with zero provider requests', async t => {
  await withCredentials(async () => {
    const width = 120, height = 100;
    const source = await sharp({ create: { width, height, channels: 3, background: '#b7783c' } }).png().toBuffer();
    const alpha = Buffer.alloc(width * height);
    for (let y = 20; y < 90; y++) for (let x = 25; x < 95; x++) alpha[y * width + x] = 255;
    for (let y = 30; y < 65; y++) for (let x = 40; x < 80; x++) alpha[y * width + x] = 0;
    for (let y = 20; y <= 30; y++) alpha[y * width + 60] = 0; // Open food surface cannot safely be filled.
    const mask = await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const storage = isolatedImageStorage(source);
    const input = currentHeroInput('clay-pot');
    input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    let requests = 0;
    const network = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      requests++; assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      const href = String(url instanceof Request ? url.url : url);
      if (href === 'https://fal.media/files/open-pot.png') return new Response(new Uint8Array(mask), { headers: { 'Content-Type': 'image/png' } });
      return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ masks: [{ url: 'https://fal.media/files/open-pot.png' }] });
    });
    await assert.rejects(storage.poll(heroCutoutModel, 'paid-mask-receipt', 'rejected-mask-job', 'hero', input, null), code('AI_IMAGE_INVALID'));
    assert.equal(requests, 3);
    assert.deepEqual(storage.saved.get('ai/rejected-mask-job/accepted-mask-v1'), mask);
    assert(!storage.saved.has('ai/rejected-mask-job/web-v1.webp'), 'Rejected geometry must not create an output photo.');
    assert(!storage.saved.has('ai/rejected-mask-job/original-v1.webp'));
    const savedBeforeReplay = storage.saved.size;
    network.mock.restore();
    t.mock.method(globalThis, 'fetch', async () => assert.fail('Cached mask processing must not request another provider result.'));
    await assert.rejects(storage.poll(heroCutoutModel, 'paid-mask-receipt', 'rejected-mask-job', 'hero', input, null), code('AI_IMAGE_INVALID'));
    assert.equal(storage.saved.size, savedBeforeReplay, 'Replay preserves all accepted mask evidence without another write.');
  });
});

test('raw hero mask retention rejects unsupported actual formats despite an allowed content type', async t => {
  await withCredentials(async () => {
    const unsupported = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'white' } }).tiff().toBuffer();
    const storage = isolatedImageStorage();
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      const href = String(url instanceof Request ? url.url : url);
      if (href === 'https://fal.media/files/unsupported.png') return new Response(new Uint8Array(unsupported), { headers: { 'Content-Type': 'image/png' } });
      return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ masks: [{ url: 'https://fal.media/files/unsupported.png' }] });
    });
    await assert.rejects(storage.poll(heroCutoutModel, 'accepted-receipt', 'unsupported-mask', 'hero', original(), null), code('AI_IMAGE_INVALID'));
    assert.deepEqual([...storage.saved.keys()], ['ai/unsupported-mask/accepted-mask-candidates-v1.json'], 'Only the accepted response manifest is retained; unsupported mask bytes and output images are rejected.');
  });
});

test('free aperture correction retrieves the accepted mask using GET only and preserves its holes', async t => {
  await withCredentials(async () => {
    const { source, mask, width } = await sauceboatCutoutFixture();
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url); requests.push(href);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET', 'Free correction must never submit a paid image or mask.');
      if (href === 'https://fal.media/files/accepted-aperture-mask.png') return new Response(new Uint8Array(mask), { headers: { 'Content-Type': 'image/png' } });
      assert.match(href, /sam-3.*accepted-mask-receipt/);
      assert.doesNotMatch(href, /status\?/);
      return Response.json({ masks: [{ url: 'https://fal.media/files/unselected-mask.png' }, { url: 'https://fal.media/files/accepted-aperture-mask.png' }], scores: [0.1, 0.99] });
    });
    for (const container of ['jar', 'bottle', 'sauceboat'] as const) {
      const input = currentHeroInput(container); input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
      const storage = isolatedImageStorage(source);
      const result = await storage.repair(input, `free-aperture-${container}`);
      assert.equal(result.cost.chargedUsd, '0.00000000');
      assert.equal(result.asset.styleProfile, heroPresentationProfile);
      assert.match(result.notes.join(' '), /Zachowano prześwity.*Bez nowego płatnego zlecenia/);
      assert.deepEqual(storage.reads.filter(path => path.startsWith('test/')), ['test/original.png'], 'The filled web cutout is not the source of repaired transparency.');
      const pixels = await sharp(storage.saved.get(`ai/free-aperture-${container}/web-v1.webp`)!).ensureAlpha().raw().toBuffer();
      assert.equal(pixels[(20 * width + 82) * 4 + 3], 0);
      assert.equal(pixels[(22 * width + 30) * 4 + 3], container === 'sauceboat' ? 255 : 0);
    }
    assert.equal(requests.length, 6);
  });
});

test('free aperture correction rejects missing or foreign mask receipts before reading source pixels', async t => {
  const source = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#c89650' } }).png().toBuffer();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Invalid receipts cannot contact the provider'); });
  const input = currentHeroInput('sauceboat'); input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
  for (const changes of [{ providerRequestId: null }, { providerFinishedAt: null }, { status: 'generating' }, { recipeId: 'other-recipe' }, { kind: 'ingredient' }, { model: approvedImageModel }, { provider: 'openai' }, { result: { asset: { id: 'other-asset' } } }]) {
    const storage = isolatedImageStorage(source, changes);
    await assert.rejects(storage.repair(input, 'rejected-aperture-correction'), code('AI_REFERENCE_UNAVAILABLE'));
    assert.equal(storage.reads.length, 0); assert.equal(storage.saved.size, 0);
  }
  assert.equal(requests, 0);
});

test('plate and legacy interior repair still fills enclosed holes without requesting a mask', async t => {
  const side = 20;
  const source = await sharp({ create: { width: side, height: side, channels: 3, background: '#c89650' } }).png().toBuffer();
  const opacity = Buffer.alloc(side * side);
  for (let y = 3; y < 17; y++) for (let x = 3; x < 17; x++) opacity[y * side + x] = 255;
  opacity[10 * side + 10] = 0;
  const mask = await sharp(opacity, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
  const cutout = await applyHeroMask(source, mask);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Ceramic and legacy local repair must not fetch a mask'); });
  for (const legacy of [false, true]) {
    const input = currentHeroInput(legacy ? 'jar' : 'plate');
    if (legacy) delete input.aiPhotography;
    input.recipe.image = '/media/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    const storage = isolatedImageStorage(source, { providerRequestId: null }, cutout.bytes);
    const result = await storage.repair(input, `local-fill-${legacy}`);
    assert.equal(result.cost.chargedUsd, '0.00000000');
    const pixels = await sharp(storage.saved.get(`ai/local-fill-${legacy}/web-v1.webp`)!).ensureAlpha().raw().toBuffer();
    assert.equal(pixels[(10 * side + 10) * 4 + 3], 255);
  }
});

function recoverableHeroSource(): FailedHeroSource {
  return { id: 'ee0f47b4-aafb-4c37-9e32-76a1bbe078bb', recipeId: 'test-recipe', kind: 'hero', provider: 'fal', model: approvedImageModel,
    status: 'failed', providerRequestId: 'existing-request', providerFinishedAt: new Date(), errorCode: 'AI_TRANSPARENCY_MISSING', result: null, appliedRevision: null };
}

test('ingredient mask prompt names the visible liquid bowl instead of an invisible spirit ingredient',()=>{
  const ingredient=original().recipe.ingredients[0];
  assert.equal(ingredientMaskPrompt({...ingredient,name:{pl:'Spirytus',en:'Food-grade rectified spirit'}}),'bowl');
  assert.equal(ingredientMaskPrompt({...ingredient,name:{pl:'Mielone orzechy włoskie',en:'Ground walnuts'}}),'Ground walnuts');
});

test('only a confirmed empty masks array gets the retryable provider error',async t=>{
  await withCredentials(async()=>{
    for(const [data,expected] of [[{masks:[]},'AI_MASK_NOT_FOUND'],[{},'AI_IMAGE_INVALID'],[null,'AI_IMAGE_INVALID'],[{masks:'empty'},'AI_IMAGE_INVALID'],[{masks:[{}]},'AI_IMAGE_INVALID']] as const){
      const mock=t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
        assert.equal((init?.method??'GET').toUpperCase(),'GET');
        const href=String(url instanceof Request?url.url:url);
        return href.includes('/status?')?Response.json({status:'COMPLETED'}):Response.json(data);
      });
      try{await assert.rejects(pollImage(heroCutoutModel,'mock-existing','mock-job','ingredient',original(),'cheese'),code(expected));}
      finally{mock.mock.restore();}
    }
  });
});

test('accepted SAM result failures report their exact read stage without repeating a paid request', async t => {
  await withCredentials(async () => {
    for (const [status, disposition] of [[422, 'request-rejected'], [503, 'retryable-response']] as const) {
      const storage = isolatedImageStorage();
      const requestId = '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf';
      const jobId = 'c9fa7908-1c65-4e5d-9afc-66a1928cd227';
      let terminal = 0; const methods: string[] = [];
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new URL(String(url instanceof Request ? url.url : url));
        assert.equal(request.hostname, 'queue.fal.run'); assert.equal(request.pathname.startsWith(`/fal-ai/sam-3/requests/${requestId}`), true);
        const method = (init?.method ?? 'GET').toUpperCase(); methods.push(method);
        assert.equal(method, 'GET'); assert.match(request.href, new RegExp(requestId));
        if (request.href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ message: 'private prompt and credential', detail: 'https://private.invalid/token' }, { status });
      });
      try {
        await assert.rejects(storage.poll(heroCutoutModel, requestId, jobId, 'hero', original(), null, async () => { terminal++; }), error => Boolean(error && typeof error === 'object' && 'status' in error && error.status === status));
        assert.equal(methods.length, status === 422 ? 2 : 5);
        assert.equal(methods.every(method => method === 'GET'), true); assert.equal(terminal, 1);
        assert.equal(storage.saved.size, 0); assert.deepEqual(storage.reads, [`ai/${jobId}/accepted-mask-v2`, `ai/${jobId}/accepted-mask-v1`, `ai/${jobId}/accepted-mask-candidates-v1.json`]);
        assert.equal(storage.diagnostics.length, 1);
        assert.equal(storage.diagnostics[0].stage, 'provider-result');
        assert.equal(storage.diagnostics[0].httpStatus, status);
        assert.equal(storage.diagnostics[0].httpDisposition, disposition);
        assert.equal(storage.diagnostics[0].providerRequestId, requestId);
        assert.doesNotMatch(JSON.stringify(storage.diagnostics), /private|credential|prompt|https|token/);
      } finally { mock.mock.restore(); }
    }
  });
});

test('accepted receipt inspection validates existing SAM output using two GETs without downloading, formatting or writing', async t => {
  await withCredentials(async () => {
    const job = { id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', provider: 'fal', model: heroCutoutModel, kind: 'hero' };
    const requests: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new URL(String(url instanceof Request ? url.url : url));
      assert.equal(request.hostname, 'queue.fal.run'); assert.match(request.pathname, new RegExp(job.providerRequestId));
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET'); requests.push(request.pathname);
      return request.pathname.endsWith('/status') ? Response.json({ status: 'COMPLETED' }) : Response.json({ masks: [{ url: 'https://v3.fal.media/files/known-mask.png' }, { url: 'https://v3.fal.media/files/other-mask.png' }], scores: [0.9299, 0.5857] });
    });
    try {
      assert.deepEqual(await inspectAcceptedPhotoReceipt(job), { status: 'available', stage: 'result-schema', providerStatus: 'COMPLETED', resultValidated: true, maskCount: 2 });
      assert.equal(requests.length, 2);
    } finally { mock.mock.restore(); }
  });
});

test('accepted receipt inspection distinguishes blocked redirects, result rejection and transient responses without another POST', async t => {
  await withCredentials(async () => {
    const job = { id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', provider: 'fal', model: heroCutoutModel, kind: 'hero' };
    for (const outcome of ['redirect', 422, 503] as const) {
      let calls = 0;
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new URL(String(url instanceof Request ? url.url : url));
        assert.equal(request.hostname, 'queue.fal.run'); assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET'); calls++;
        if (request.pathname.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        if (outcome === 'redirect') throw new TypeError('private fetch URL', { cause: new Error('unexpected redirect') });
        return Response.json({ message: 'private prompt https://private.invalid', detail: 'secret-token' }, { status: outcome });
      });
      try {
        const result = await inspectAcceptedPhotoReceipt(job);
        assert.equal(result.status, 'unavailable'); assert.equal(result.stage, 'provider-result'); assert.equal(result.providerStatus, 'COMPLETED');
        assert.equal(result.failure?.redirectBlocked, outcome === 'redirect');
        if (outcome !== 'redirect') assert.equal(result.failure?.httpStatus, outcome);
        assert.equal(calls, outcome === 503 ? 5 : 2); assert.doesNotMatch(JSON.stringify(result), /private|secret|https|prompt/);
      } finally { mock.mock.restore(); }
    }
  });
});

test('receipt inspection refuses unaccepted and non-photo jobs before any provider request', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Ineligible receipt reached the network.'));
  const job = { id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', provider: 'fal', model: heroCutoutModel, kind: 'hero' };
  for (const change of [{ providerRequestId: null }, { kind: 'recipe' }, { provider: 'openai' }, { model: 'unapproved/model' }]) assert.deepEqual(await inspectAcceptedPhotoReceipt({ ...job, ...change }), { status: 'ineligible', stage: 'eligibility', resultValidated: false });
});

test('deep SAM inspection identifies a mask transport failure without reading sources or writing files', async t => {
  await withCredentials(async () => {
    const storage = isolatedImageStorage();
    const job = { id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', provider: 'fal', model: heroCutoutModel, kind: 'hero', input: original() };
    const methods: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      const method = (init?.method ?? 'GET').toUpperCase(); methods.push(method); assert.equal(method, 'GET');
      if (href === 'https://fal.media/files/accepted-mask.png') return new Response('Unavailable', { status: 403 });
      assert.equal(new URL(href).hostname, 'queue.fal.run');
      return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ masks: [{ url: 'https://fal.media/files/accepted-mask.png' }] });
    });
    try {
      const result = await storage.inspect(job, true);
      assert.equal(result.status, 'unavailable'); assert.equal(result.stage, 'mask-download');
      assert.equal(result.resultValidated, true); assert.equal(result.mediaValidated, false);
      assert.equal(result.failure?.code, 'AI_REFERENCE_UNAVAILABLE'); assert.equal(result.failure?.httpStatus, 403);
      assert.deepEqual(methods, ['GET', 'GET', 'GET']); assert.equal(storage.saved.size, 0); assert.equal(storage.reads.length, 0);
      assert.doesNotMatch(JSON.stringify(result), /https|image_url|prompt|Unavailable/);
    } finally { mock.mock.restore(); }
  });
});

test('deep SAM inspection can recover and encode the exact opaque source without populating its cache or saving assets', async t => {
  await withCredentials(async () => {
    const side = 1024;
    const source = await sharp({ create: { width: side, height: side, channels: 3, background: '#cba977' } }).png().toBuffer();
    const opacity = Buffer.alloc(side * side);
    for (let y = 180; y < 840; y++) for (let x = 180; x < 840; x++) opacity[y * side + x] = 255;
    const mask = await sharp(opacity, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
    const content = original(); content.recipe.image = '/ai-result/ee0f47b4-aafb-4c37-9e32-76a1bbe078bb';
    const storage = isolatedImageStorage(source, { id: 'ee0f47b4-aafb-4c37-9e32-76a1bbe078bb', model: approvedImageModel, status: 'failed', providerRequestId: 'accepted-original', errorCode: 'AI_TRANSPARENCY_MISSING', result: null, appliedRevision: null, input: content }, undefined, source);
    const job = { id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', provider: 'fal', model: heroCutoutModel, kind: 'hero', input: content };
    const methods: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      const method = (init?.method ?? 'GET').toUpperCase(); methods.push(method); assert.equal(method, 'GET');
      if (href === 'https://fal.media/files/accepted-mask.png') return new Response(new Uint8Array(mask), { headers: { 'Content-Type': 'image/png' } });
      assert.equal(new URL(href).hostname, 'queue.fal.run');
      return href.includes('/status?') ? Response.json({ status: 'COMPLETED' }) : Response.json({ masks: [{ url: 'https://fal.media/files/accepted-mask.png' }] });
    });
    try {
      const result = await storage.inspect(job, true);
      assert.equal(result.status, 'available'); assert.equal(result.stage, 'photo-encode');
      assert.equal(result.resultValidated, true); assert.equal(result.mediaValidated, true);
      assert.equal(result.media?.width, side); assert.equal(result.media?.height, side);
      assert.match(result.media!.webSha256, /^[a-f0-9]{64}$/); assert.equal(result.media!.maskSha256, createHash('sha256').update(mask).digest('hex'));
      assert.deepEqual(methods, ['GET', 'GET', 'GET']); assert.equal(storage.saved.size, 0);
      assert.equal(storage.reads.length, 2, 'Only the missing immutable source cache is probed; its recovery write is a no-op.');
    } finally { mock.mock.restore(); }
  });
});

test('deep inspection requires the captured recipe and matching ingredient before any transport', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Missing capture reached the network.'));
  const job = { id: 'c9fa7908-1c65-4e5d-9afc-66a1928cd227', providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', provider: 'fal', model: heroCutoutModel, kind: 'hero' };
  for (const invalid of [job, { ...job, input: original(), recipeId: 'different-recipe' }, { ...job, kind: 'ingredient', input: original(), targetId: 'missing-ingredient' }]) assert.deepEqual(await inspectAcceptedPhotoReceipt(invalid, true), { status: 'ineligible', stage: 'eligibility', resultValidated: false, mediaValidated: false });
});

test('semantic v2 permits one confirmed missing-mask correction and keeps every other accepted result deduplicated',()=>{
  const source={...recoverableHeroSource(),kind:'ingredient',model:heroCutoutModel,ingredientKey:'same-style-and-form',brief:'Legacy ingredient correction',errorCode:'AI_IMAGE_INVALID',errorMessage:'Dostawca nie zwrócił maski wycięcia.'};
  assert(canRetryMissingIngredientMask(source,ingredientCutoutRecoveryBrief,source.ingredientKey));
  assert(canRetryMissingIngredientMask({...source,errorCode:'AI_MASK_NOT_FOUND'},ingredientCutoutRecoveryBrief,source.ingredientKey));
  for(const change of [{status:'ready'},{status:'applied'},{status:'uncertain'},{kind:'hero'},{providerRequestId:null},{providerFinishedAt:null},{result:{}},{errorMessage:'Different image failure'},{errorCode:'SUBMISSION_UNCERTAIN'},{brief:ingredientCutoutRecoveryBrief},{ingredientKey:'different-form'}]){
    assert.equal(canRetryMissingIngredientMask({...source,...change},ingredientCutoutRecoveryBrief,source.ingredientKey),false);
  }
  assert.equal(canRetryMissingIngredientMask(source,'An arbitrary new brief',source.ingredientKey),false);
});

test('ingredient recovery requires the original target, product form and style before reading a source', async t => {
  const input=original();input.recipe.id='test-recipe';
  const ingredient={...input.recipe.ingredients[0],name:{pl:'Mielone orzechy włoskie',en:'Ground walnuts'}};
  input.recipe.ingredients[0]=ingredient;
  const source:FailedHeroSource={...recoverableHeroSource(),kind:'ingredient',targetId:ingredient.id,input,ingredientKey:ingredientImageIdentity(ingredient).key};
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Invalid ingredient sources cannot use transport');});
  const storage={async read(){calls++;return null;},async write(){calls++;}};
  assert(isRecoverablePhotoSource(source,source.recipeId,'ingredient',ingredient.id,ingredient));
  for(const change of [
    {recipeId:'foreign-recipe'},{kind:'hero'},{targetId:'different-ingredient'},{targetId:null},
    {ingredientKey:ingredientImageIdentity(ingredient,'unapproved-style').key},{input:undefined},
    {input:{...input,recipe:{...input.recipe,ingredients:[]}}},
  ]){
    const invalid:FailedHeroSource={...source,...change};
    assert.equal(isRecoverablePhotoSource(invalid,source.recipeId,'ingredient',ingredient.id,ingredient),false);
    await assert.rejects(recoverFailedPhoto(invalid,source.recipeId,'ingredient',ingredient.id,ingredient,storage),code('AI_REFERENCE_UNAVAILABLE'));
  }
  const whole={...ingredient,name:{pl:'Orzechy włoskie',en:'Whole walnuts'}};
  await assert.rejects(recoverFailedPhoto(source,source.recipeId,'ingredient',ingredient.id,whole,storage),code('AI_REFERENCE_UNAVAILABLE'));
  assert.equal(calls,0);
});

test('ingredient recovery reads and caches only the completed photograph with no generation POST',async t=>{
  await withCredentials(async()=>{
    const input=original();input.recipe.id='test-recipe';
    const ingredient=input.recipe.ingredients[0];
    const source:FailedHeroSource={...recoverableHeroSource(),kind:'ingredient',targetId:ingredient.id,input,ingredientKey:ingredientImageIdentity(ingredient).key};
    const png=await sharp({create:{width:1024,height:1024,channels:3,background:'#ddccaa'}}).png().toBuffer();
    const saved=new Map<string,Buffer>();let reads=0;
    t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
      const href=String(url instanceof Request?url.url:url);
      assert.equal((init?.method??(url instanceof Request?url.method:'GET')).toUpperCase(),'GET');reads++;
      if(href.includes('/status?'))return Response.json({status:'COMPLETED'});
      if(href.startsWith('https://queue.fal.run/'))return Response.json({images:[{url:'https://fal.media/files/existing-ingredient.png'}]});
      assert.equal(href,'https://fal.media/files/existing-ingredient.png');
      return new Response(new Uint8Array(png),{headers:{'Content-Type':'image/png'}});
    });
    const storage={async read(path:string){return saved.get(path)??null;},async write(path:string,bytes:Buffer){assert.equal(saved.size,0);saved.set(path,bytes);}};
    const recovered=await recoverFailedPhoto(source,source.recipeId,'ingredient',ingredient.id,ingredient,storage);
    assert.equal(reads,3);assert.equal(saved.size,1);assert(saved.has(`ai/${source.id}/recovered-original.webp`));
    assert.deepEqual(await sharp(recovered).raw().toBuffer(),await sharp(png).raw().toBuffer());
    assert.deepEqual(await recoverFailedPhoto(source,source.recipeId,'ingredient',ingredient.id,ingredient,storage),recovered);
    assert.equal(reads,3);
  });
});

test('hero recovery admits only a completed same-recipe transparency failure before any transport', async t => {
  const source = recoverableHeroSource();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Invalid recovery must not use transport'); });
  const storage = { async read() { calls++; return null; }, async write() { calls++; } };
  assert(isRecoverableHeroSource(source, source.recipeId));
  for (const change of [
    { recipeId: 'other-recipe' }, { kind: 'ingredient' }, { provider: 'openai' }, { model: heroCutoutModel }, { status: 'uncertain' },
    { providerRequestId: null }, { providerRequestId: '../other/request' }, { providerFinishedAt: null }, { errorCode: 'OTHER_ERROR' },
    { result: {} }, { appliedRevision: 12 }, { id: '../image' },
  ]) {
    const invalid: FailedHeroSource = { ...source, ...change };
    assert.equal(isRecoverableHeroSource(invalid, source.recipeId), false);
    await assert.rejects(recoverFailedHeroPhoto(invalid, source.recipeId, storage), code('AI_REFERENCE_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
});

test('hero recovery reads the existing result with GET and caches its pixels without a generation POST', async t => {
  await withCredentials(async () => {
    const source = recoverableHeroSource();
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ddccaa' } }).png().toBuffer();
    const saved = new Map<string, Buffer>();
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? (url instanceof Request ? url.method : 'GET')).toUpperCase(), 'GET');
      requests.push(href);
      if (href === 'https://queue.fal.run/openai/gpt-image-2.5/requests/existing-request/status?logs=0') return Response.json({ status: 'COMPLETED' });
      if (href === 'https://queue.fal.run/openai/gpt-image-2.5/requests/existing-request') return Response.json({ images: [{ url: 'https://fal.media/files/existing.png' }] });
      if (href === 'https://fal.media/files/existing.png') return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
      throw new Error('Unknown transport is blocked in the test');
    });
    const storage = { async read(pathname: string) { return saved.get(pathname) ?? null; }, async write(pathname: string, bytes: Buffer) { assert.equal(saved.has(pathname), false); saved.set(pathname, bytes); } };
    const recovered = await recoverFailedHeroPhoto(source, source.recipeId, storage);
    assert.equal(requests.length, 3); assert.equal(saved.size, 1);
    assert(saved.has(`ai/${source.id}/recovered-original.webp`));
    assert.deepEqual(await sharp(recovered).raw().toBuffer(), await sharp(png).raw().toBuffer());
    assert.deepEqual(await recoverFailedHeroPhoto(source, source.recipeId, storage), recovered);
    assert.equal(requests.length, 3, 'cached mask polling must not depend on provider CDN availability');
  });
});

test('a registered SAM archive recovers its exact source without another cache copy or provider request', async t => {
  const source = recoverableHeroSource();
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ddccaa' } }).png().toBuffer();
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('A retained source never asks the provider for another result'); });
  const recovered = await recoverFailedHeroPhoto(source, source.recipeId, {
    retained: async () => 'ai/existing-sam/original.png',
    read: async pathname => { assert.equal(pathname, 'ai/existing-sam/original.png'); return png; },
    write: async () => { assert.fail('The registered archive already preserves this source'); },
  });
  assert.deepEqual(await sharp(recovered).raw().toBuffer(), await sharp(png).raw().toBuffer());
});

test('hero recovery rejects an unapproved result URL before downloading or writing a source', async t => {
  await withCredentials(async () => {
    let writes = 0; let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET'); calls++;
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      assert.match(href, /^https:\/\/queue\.fal\.run\//);
      return Response.json({ images: [{ url: 'https://example.invalid/private.png' }] });
    });
    const source = recoverableHeroSource();
    await assert.rejects(recoverFailedHeroPhoto(source, source.recipeId, { async read() { return null; }, async write() { writes++; } }), code('AI_IMAGE_URL_INVALID'));
    assert.equal(calls, 2); assert.equal(writes, 0);
  });
});

test('hero recovery stops on an expired source without a paid POST or cached replacement', async t => {
  await withCredentials(async () => {
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (href.startsWith('https://queue.fal.run/')) return Response.json({ images: [{ url: 'https://fal.media/files/expired.png' }] });
      assert.equal(href, 'https://fal.media/files/expired.png');
      return new Response(null, { status: 404 });
    });
    const source = recoverableHeroSource();
    await assert.rejects(recoverFailedHeroPhoto(source, source.recipeId, { async read() { return null; }, async write() { writes++; } }), error =>
      error instanceof ProviderError && error.code === 'AI_REFERENCE_UNAVAILABLE' && !error.uncertain);
    assert.equal(writes, 0);
  });
});

test('an unavailable accepted photo download retains its receipt without another POST or storage write', async t => {
  await withCredentials(async () => {
    for (const status of [404, 503]) {
      const storage = isolatedImageStorage();
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url instanceof Request ? url.url : url);
        assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
        if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
        if (href.startsWith('https://queue.fal.run/')) return Response.json({ images: [{ url: 'https://fal.media/files/accepted-photo.png' }] });
        assert.equal(href, 'https://fal.media/files/accepted-photo.png');
        return new Response(null, { status });
      });
      try {
        const input = original();
        await assert.rejects(storage.poll(imageModel, 'existing-request', 'existing-job', 'step', input, input.recipe.steps[0].id),
          error => error instanceof ProviderError && error.code === 'AI_IMAGE_DOWNLOAD_UNAVAILABLE' && error.uncertain);
        assert.equal(storage.saved.size, 0); assert.equal(storage.reads.length, 0);
      } finally { mock.mock.restore(); }
    }
  });
});

test('hero recovery permits invalid partial alpha but blocks an already valid cutout', async () => {
  const opaque = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ddccaa' } }).raw().toBuffer();
  const invalid = Buffer.from(opaque); invalid[(8 * 16 + 8) * 4 + 3] = 0;
  const invalidPng = await sharp(invalid, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
  await assert.rejects(validateHeroCutoutSource(invalidPng), code('AI_ALREADY_HAS_CUTOUT'));
  await validateHeroCutoutSource(invalidPng, true);
  for (const alpha of [250, 254, 255]) {
    const valid = Buffer.from(opaque);
    for (let pixel = 0; pixel < 16 * 16; pixel++) valid[pixel * 4 + 3] = alpha;
    for (const pixel of [0, 15, 15 * 16, 16 * 16 - 1]) valid[pixel * 4 + 3] = 0;
    const validPng = await sharp(valid, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
    await assert.rejects(validateHeroCutoutSource(validPng, true), code('AI_ALREADY_HAS_CUTOUT'));
    assert.deepEqual(await sharp(validPng).raw().toBuffer(), valid, 'No mask may replace an already valid cutout or its alpha.');
  }
});

test('hero recovery preserves partial-alpha RGB as an opaque source for mask and bowl filling', async t => {
  await withCredentials(async () => {
    const source = recoverableHeroSource();
    const width = 1024; const height = 1024;
    const pixels = await sharp({ create: { width, height, channels: 4, background: '#ddccaa' } }).raw().toBuffer();
    pixels[(512 * width + 512) * 4 + 3] = 0;
    const partial = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      if (href.includes('/status?')) return Response.json({ status: 'COMPLETED' });
      if (href.startsWith('https://queue.fal.run/')) return Response.json({ images: [{ url: 'https://fal.media/files/partial.png' }] });
      assert.equal(href, 'https://fal.media/files/partial.png');
      return new Response(new Uint8Array(partial), { headers: { 'Content-Type': 'image/png' } });
    });
    let cached: Buffer | null = null;
    const recovered = await recoverFailedHeroPhoto(source, source.recipeId, { async read() { return null; }, async write(_pathname, bytes) { cached = bytes; } });
    assert.ok(cached); assert.deepEqual(await sharp(cached).raw().toBuffer(), await sharp(recovered).raw().toBuffer());
    assert.equal((await sharp(recovered).metadata()).hasAlpha, false);
    assert.deepEqual(await sharp(recovered).raw().toBuffer(), await sharp(partial).removeAlpha().raw().toBuffer());
    await validateHeroCutoutSource(recovered, true);
    const mask = Buffer.alloc(width * height);
    for (let y = 256; y < 768; y++) for (let x = 256; x < 768; x++) mask[y * width + x] = 255;
    const maskPng = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const cutout = await applyHeroMask(recovered, maskPng);
    const filled = await fillEnclosedCutout(recovered, cutout.bytes);
    const rgba = await sharp(filled.bytes).raw().toBuffer();
    assert.equal(rgba[3], 0); assert.equal(rgba[(512 * width + 512) * 4 + 3], 255);
  });
});

test('fal transport failure, 503 and ambiguous 408 never automatically repeat the paid POST', async t => {
  for (const scenario of ['transport', '503', '408']) {
    await withCredentials(async () => {
      let posts = 0;
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(networkGuard(url, init).method, 'POST'); posts++;
        if (scenario === 'transport') throw new TypeError('Simulated transport failure');
        return Response.json({ error: 'Simulated unavailable provider' }, { status: Number(scenario) });
      });
      try {
        await assert.rejects(submitImage(imageModel, 'hero', original(), null, 'Apetyczny kadr'), code('AI_SUBMISSION_UNCERTAIN', true));
        assert.equal(posts, 1);
      } finally { mock.mock.restore(); }
    });
  }
});

test('pre-POST cancellation prevents any paid image submission', async t => {
  await withCredentials(async () => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No network request was expected'); });
    await assert.rejects(submitImage(imageModel, 'hero', original(), null, 'Brief', async () => { throw new ProviderError('AI_SUBMISSION_BLOCKED', 'Stopped before sending'); }), code('AI_SUBMISSION_BLOCKED', false));
    assert.equal(calls, 0);
  });
});

test('OpenAI background submission retains one request ID and never retries ambiguous 503 or 408', async t => {
  await withCredentials(async () => {
    let calls = 0; let rejectionStatus: number | null = null;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'POST'); calls++;
      return rejectionStatus ? Response.json({ error: { message: 'Simulated unavailable provider' } }, { status: rejectionStatus }) : Response.json({ id: 'resp_fake', object: 'response', status: 'queued', output: [] });
    });
    assert.equal(await submitText(recipeModel, original(), 'Brief'), 'resp_fake'); assert.equal(calls, 1);
    for (const status of [503, 408]) {
      calls = 0; rejectionStatus = status;
      await assert.rejects(submitText(recipeModel, original(), 'Brief'), code('AI_SUBMISSION_UNCERTAIN', true));
      assert.equal(calls, 1);
    }
  });
});

test('completed OpenAI refusal preserves known usage cost and never produces an applicable proposal', async t => {
  await withCredentials(async () => {
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'GET');
      return Response.json({ id: 'resp_fake', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Simulated refusal' }] }], usage: { input_tokens: 10, output_tokens: 20 } });
    });
    await assert.rejects(pollText(recipeModel, 'resp_fake', original()), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'AI_GENERATION_REFUSED'); assert.equal(error.uncertain, false);
      assert.equal(error.chargedUsd, '0.00110000');
      return true;
    });
  });
});

test('completed OpenAI result is validated without losing its known usage cost', async t => {
  await withCredentials(async () => {
    const input = original();
    let output = JSON.stringify(proposal(input));
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'GET');
      return Response.json({
        id: 'resp_fake', object: 'response', status: 'completed',
        output: [{ type: 'message', id: 'msg_fake', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: output, annotations: [] }] }],
        usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 } },
      });
    });
    const result = await pollText(recipeModel, 'resp_fake', input);
    assert.equal(result.done, true);
    if (!result.done) assert.fail('Expected a validated completed recipe.');
    assert.equal(result.content.author, input.author);
    assert.deepEqual(result.content.sources, input.sources);
    assert('chargedUsd' in result.cost);
    assert.equal(result.cost.chargedUsd, '0.01600000');
    const cited = proposal(input);
    cited.storage.pl += ' Szczegóły: https://cook.example/storage.';
    output = JSON.stringify(cited);
    await assert.rejects(pollText(recipeModel, 'resp_fake', input), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'AI_RESULT_INVALID');
      assert.equal(error.repairable, true);
      assert.equal(error.chargedUsd, '0.01600000');
      assert(error.issues.some(issue => issue.field === 'storage.pl'));
      return true;
    });
    output = '{"invalid":true}';
    await assert.rejects(pollText(recipeModel, 'resp_fake', input), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'AI_RESULT_INVALID'); assert.equal(error.uncertain, false);
      assert.equal(error.chargedUsd, '0.01600000');
      return true;
    });
  });
});

test('a local dietary vocabulary gap preserves the receipt cost and diagnostic without becoming a paid model repair', async t => {
  await withCredentials(async () => {
    const input = original();
    input.aiPhotography = { recipeDietVersion: 'ingredient-diet-v1' };
    const raw = proposal(input);
    raw.ingredients = [{ ...raw.ingredients[0], id: 'unidentified', name: { pl: 'niezidentyfikowany produkt', en: 'unidentified pantry item' }, note: null }];
    raw.steps = [{ id: 'prepare', title: { pl: 'Przygotuj', en: 'Prepare' }, text: { pl: 'Przygotuj składnik.', en: 'Prepare the ingredient.' }, timerMinutes: null }];
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'GET'); reads++;
      return Response.json({ id: 'resp_existing', object: 'response', status: 'completed',
        output: [{ type: 'message', id: 'msg_existing', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 20 } });
    });
    await assert.rejects(pollText(recipeModel, 'resp_existing', input), error => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, 'AI_RESULT_INVALID');
      assert.equal(error.repairable, false);
      assert.equal(error.uncertain, false);
      assert.equal(error.chargedUsd, '0.00110000');
      assert.match(error.message, /Aplikacja nie rozpoznaje składnika/);
      assert.equal(error.issues[0].code, 'DIET_INGREDIENT_UNRECOGNISED');
      return true;
    });
    assert.equal(reads, 1);
  });
});

test('researched poll requests provider sources, retains real references and bills both search calls without live transport', async t => {
  await withCredentials(async () => {
    const input = original(); input.aiPhotography = { recipeProposalVersion, recipeResearchVersion };
    const verified = { title: 'Verified culinary technique', url: 'https://www.seriouseats.com/verified-recipe-technique' };
    let proposedUrl = verified.url; let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = networkGuard(url, init); reads++;
      assert.equal(request.method, 'GET');
      assert.deepEqual(new URL(request.href).searchParams.getAll('include[]'), ['web_search_call.action.sources']);
      return Response.json({
        id: 'resp_fake_researched', object: 'response', status: 'completed',
        output: [
          { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search', query: 'recipe technique', sources: [{ type: 'url', url: verified.url }] } },
          { type: 'web_search_call', id: 'search-2', status: 'completed', action: { type: 'open_page', url: verified.url } },
          { type: 'message', id: 'msg_researched', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: JSON.stringify({
            ...proposal(input), heroPresentation: { container: 'plate', finalAppearance: { pl: 'Gotowa potrawa na talerzu.', en: 'The finished dish on a plate.' }, evidenceStepIds: [input.recipe.steps.at(-1)!.id] },
            researchSources: [{ title: verified.title, url: proposedUrl }],
          }) }] },
        ],
        usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 } },
      });
    });
    const result = await pollText(recipeModel, 'resp_fake_researched', input);
    assert.equal(result.done, true);
    if (!result.done) assert.fail('Expected a completed researched recipe.');
    assert.deepEqual(result.content.sources[0], input.sources[0]);
    assert.equal(result.content.sources.length, input.sources.length + 1);
    assert.deepEqual(result.content.sources.at(-1), { id: 'research-2', ...verified });
    assert('chargedUsd' in result.cost);
    assert.equal(result.cost.chargedUsd, '0.03600000', 'Token cost 0.016 plus two search calls at 0.01 each.');
    proposedUrl = 'https://invented.example/recipe';
    await assert.rejects(pollText(recipeModel, 'resp_fake_researched', input), error => error instanceof ProviderError
      && error.code === 'AI_RESULT_INVALID' && error.chargedUsd === '0.03600000');
    assert.equal(reads, 2, 'Both operations only read the captured provider response.');
  });
});

test('a repair submission resends stable instructions, strict schema and exact issues once without more research', async t => {
  await withCredentials(async () => {
    const input = original(); input.aiPhotography = { recipeProposalVersion, recipeResearchVersion };
    const issues = [{ field: 'steps.mix.pl', message: 'Odwołanie do nieznanego składnika.' }];
    const request = responseRepairRequest(recipeModel, input, 'Zachowaj intencję dania.', 'resp_parent', issues);
    assert.equal(request.previous_response_id, 'resp_parent'); assert.equal(request.background, true);
    assert.equal('tools' in request, false); assert.equal('tool_choice' in request, false);
    assert.match(request.instructions, /meticulous culinary editor/); assert.match(request.instructions, /entire method/);
    assert.deepEqual(JSON.parse(request.input).validationIssues, issues);
    assert.ok(request.text.format.schema.required?.includes('researchSources'));
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'POST'); posts++;
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'durable_repair_attempt_1');
      assert.equal(JSON.parse(String(init?.body)).previous_response_id, 'resp_parent');
      return Response.json({ id: 'resp_child', object: 'response', status: 'queued', output: [] });
    });
    assert.equal(await submitTextRepair(recipeModel, input, 'Brief', 'resp_parent', issues, undefined, 'durable_repair_attempt_1'), 'resp_child');
    assert.equal(posts, 1);
    await assert.rejects(submitTextRepair(recipeModel, input, 'Brief', 'resp_parent', issues, async () => { throw new ProviderError('AI_SUBMISSION_BLOCKED', 'Stopped'); }), code('AI_SUBMISSION_BLOCKED'));
    assert.equal(posts, 1);
  });
});

test('ambiguous repair submission is never repeated after transport or HTTP 503 failure', async t => {
  await withCredentials(async () => {
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'POST'); posts++;
      return Response.json({ error: { message: 'Private provider diagnostic' } }, { status: 503 });
    });
    await assert.rejects(submitTextRepair(recipeModel, original(), 'Brief', 'resp_parent', [{ field: 'slug.pl', message: 'Popraw adres.' }]), code('AI_SUBMISSION_UNCERTAIN', true));
    assert.equal(posts, 1);
  });
});

test('repaired research uses only confirmed ancestor receipts and charges only the current job', async t => {
  await withCredentials(async () => {
    const input = original(); input.aiPhotography = { recipeProposalVersion, recipeResearchVersion };
    const source = { title: 'Actual source', url: 'https://www.seriouseats.com/actual-source' };
    const raw = { ...proposal(input), heroPresentation: { container: 'plate', finalAppearance: { pl: 'Gotowa potrawa na talerzu.', en: 'The finished dish on a plate.' }, evidenceStepIds: [input.recipe.steps.at(-1)!.id] }, researchSources: [source] };
    const reads: string[] = []; let badSource = false; let badParent = false;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'GET');
      const id = new URL(String(url)).pathname.split('/').at(-1)!; reads.push(id);
      const isRoot = id === 'resp_root';
      return Response.json({ id, object: 'response', status: 'completed', previous_response_id: isRoot ? null : id === 'resp_first' ? 'resp_root' : badParent ? 'resp_foreign' : 'resp_first',
        output: isRoot ? [{ type: 'web_search_call', id: 'search-root', status: 'completed', action: { type: 'search', query: 'dish', sources: [{ type: 'url', url: source.url }] } }]
          : [{ type: 'message', id: 'msg_child', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ ...raw, researchSources: [{ ...source, url: badSource ? 'https://invented.example/source' : source.url }] }) }] }],
        usage: { input_tokens: isRoot ? 100000 : 1000, output_tokens: 200, input_tokens_details: { cached_tokens: isRoot ? 0 : 500, cache_write_tokens: isRoot ? 0 : 200 } },
      });
    });
    const result = await pollText(recipeModel, 'resp_second', input, ['resp_root', 'resp_first']);
    assert.equal(result.done, true); if (!result.done) assert.fail('Expected a repaired proposal.');
    assert('chargedUsd' in result.cost);
    assert.equal(result.cost.chargedUsd, '0.01600000', 'Ancestor tokens and original search were already billed to separate jobs.');
    assert.deepEqual(result.content.sources.at(-1), { id: 'research-2', ...source });
    assert.deepEqual([...reads].sort(), ['resp_first', 'resp_root', 'resp_second']);
    badSource = true;
    await assert.rejects(pollText(recipeModel, 'resp_second', input, ['resp_root', 'resp_first']), error => error instanceof ProviderError
      && error.repairable && error.chargedUsd === '0.01600000' && error.issues.some(issue => issue.field === 'researchSources.0.url'));
    badParent = true;
    await assert.rejects(pollText(recipeModel, 'resp_second', input, ['resp_root', 'resp_first']), code('AI_REPAIR_LINEAGE_INVALID'));
    const priorReads = reads.length;
    await assert.rejects(pollText(recipeModel, 'resp_second', input, ['resp_root', 'resp_first', 'resp_third']), code('AI_REPAIR_LINEAGE_INVALID'));
    assert.equal(reads.length, priorReads, 'More than two repairs are rejected before any transport.');
  });
});

test('GET authorization, quota and transient failures retain receipts and never trigger a repair POST', async t => {
  await withCredentials(async () => {
    let status = 403; let providerCode = 'forbidden'; let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(networkGuard(url, init).method, 'GET'); reads++;
      return Response.json({ error: { code: providerCode, message: 'Never expose this private diagnostic' } }, { status });
    });
    for (const [http, rawCode, expected] of [[403, 'forbidden', 'AI_PROVIDER_AUTH_REQUIRED'], [429, 'insufficient_quota', 'AI_PROVIDER_QUOTA'], [503, 'unavailable', 'AI_PROVIDER_STATUS_UNAVAILABLE']] as const) {
      status = http; providerCode = rawCode;
      await assert.rejects(pollText(recipeModel, 'resp_existing', original()), error => error instanceof ProviderError
        && error.code === expected && error.uncertain && !error.repairable && !error.message.includes('private diagnostic'));
    }
    assert.equal(reads, 3);
  });
});

test('fal billing aggregates only this request and retains reservation when receipts are incomplete', async t => {
  await withCredentials(async () => {
    let body: unknown = { billing_events: [{ request_id: 'ours', cost_total: 0.1 }, { request_id: 'ours', cost_total: 0.2 }, { request_id: 'other', cost_total: 99 }], has_more: false };
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = networkGuard(url, init); assert.equal(request.method, 'GET');
      assert.equal(new URL(request.href).searchParams.get('request_id'), 'ours');
      return Response.json(body);
    });
    assert.deepEqual(await imageBill('ours'), { chargedUsd: '0.30000000', costBasis: 'usage' });
    for (const invalid of [
      { billing_events: [{ request_id: 'ours', cost_total: 0.1 }], has_more: true },
      { billing_events: [{ request_id: 'ours', cost_total: null }] },
      { billing_events: [{ request_id: 'ours', cost_total: -1 }] },
      { billing_events: [{ request_id: 'ours', cost_total: '0.1' }] },
      { billing_events: [{ request_id: 'other', cost_total: 1 }] },
      { billing_events: [] },
    ]) { body = invalid; assert.equal(await imageBill('ours'), null); }
    body = { billing_events: [{ request_id: 'ours', cost_total: 0 }], has_more: false };
    assert.deepEqual(await imageBill('ours'), { chargedUsd: '0.00000000', costBasis: 'usage' });
  });
});

test('retained photo recovery bypasses a cached Blob 404 without contacting the provider', async t => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  const previousDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  try {
    await withCredentials(async () => {
      process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_unit';
      const source = recoverableHeroSource();
      const saved = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ddccaa' } }).png().toBuffer();
      const pathname = `/ai/${source.id}/recovered-original.png`;
      dispatcher.get('https://teststore.private.blob.vercel-storage.com')
        .intercept({ method: 'GET', path: value => value.split('?')[0] === pathname.replace('.png', '.webp') })
        .reply(404, '');
      let cachedReads = 0; let originReads = 0; let providerRequests = 0;
      const unexpectedHosts: string[] = [];
      dispatcher.get('https://teststore.private.blob.vercel-storage.com')
        .intercept({ method: 'GET', path: value => value.split('?')[0] === pathname })
        .reply(options => {
          if (new URL(options.path, 'https://example.invalid').searchParams.get('cache') !== '0') {
            cachedReads++;
            return { statusCode: 404, data: '' };
          }
          originReads++;
          return { statusCode: 200, data: saved, responseOptions: { headers: { 'Content-Type': 'image/png' } } };
        });
      t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
        const host = new URL(String(url instanceof Request ? url.url : url)).hostname;
        // Blob may first attempt a local Vercel OIDC refresh before falling
        // back to this test's explicit read/write token. Deny it offline too.
        if (host !== 'api.vercel.com') providerRequests++;
        unexpectedHosts.push(host);
        throw new Error('A retained source must not contact the provider');
      });
      const recovered = await recoverFailedHeroPhoto(source, source.recipeId);
      assert.equal(originReads, 1);
      assert.equal(cachedReads, 0);
      assert.equal(providerRequests, 0, `Unexpected global fetch hosts: ${unexpectedHosts.join(', ')}`);
      assert.deepEqual(await sharp(recovered).raw().toBuffer(), await sharp(saved).raw().toBuffer());
      dispatcher.assertNoPendingInterceptors();
    });
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.close();
  }
});
