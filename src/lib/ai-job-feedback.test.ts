import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiJob } from './ai-types';
import { aiJobFeedback, canStartNewRecipeText, jobHasOngoingWork, photoRecoveryPollInterval, recipeIssueLabel } from './ai-job-feedback';
import { readyPreparationAction } from './preparation-client';

const job = { id: 'root', recipeId: 'recipe', kind: 'recipe', status: 'failed', baseRevision: 3, errorCode: 'AI_RESULT_INVALID', errorMessage: 'Wynik wymaga poprawy.', providerRequestId: 'receipt' } as AiJob;

test('a historical failed mask directs to the recovered ready or applied source photograph', () => {
  for (const status of ['ready', 'applied'] as const) {
    const mask: AiJob = { ...job, kind: 'hero', model: 'fal-ai/sam-3/image', errorCode: 'AI_MASK_NOT_FOUND',
      photoSourceJobId: 'original', photoSourceStatus: status };
    const feedback = aiJobFeedback(mask);
    assert.equal(feedback?.tone, 'success');
    assert.equal(feedback?.primary?.action, 'view');
    assert.equal(feedback?.primary?.href, '/admin/ai/original');
    assert.match(feedback!.title, status === 'applied' ? /zapisane w szkicu/ : /gotowa/);
    assert.equal(jobHasOngoingWork(mask), false);
  }
});

test('a retained manual composition does not direct the editor to mask an older vessel', () => {
  const photo: AiJob = { ...job, kind: 'hero', errorCode: 'AI_TRANSPARENCY_MISSING', manualPhotoComposition: true };
  const feedback = aiJobFeedback(photo);
  assert.match(feedback!.title, /fotografia jest zachowana/);
  assert.doesNotMatch(feedback!.title + feedback!.description, /wymaga wycięcia|przezroczystego tła/);
  assert.equal(feedback!.primary, undefined);
  photo.photoRecovery = { jobId: 'never-submitted-mask', status: 'queued', errorCode: null, chargedUsd: null, costBasis: null };
  assert.equal(jobHasOngoingWork(photo), false);
  assert.equal(photoRecoveryPollInterval(photo), null);
  assert.equal(aiJobFeedback(photo)!.tone, 'warning');
});

test('a failed parent remains active while a bounded child repair is running', () => {
  const recovering: AiJob = { ...job, recovery: { status: 'recovering', attempt: 1, maxAttempts: 2, jobId: 'child', reason: 'Brak ilości jednego składnika.', issues: [{ field: 'recipe.ingredients.0.quantity', message: 'Podaj ilość składnika.' }], canResume: false } };
  assert.equal(jobHasOngoingWork(recovering), true);
  const feedback = aiJobFeedback(recovering, 3)!;
  assert.equal(feedback.tone, 'working');
  assert.deepEqual(feedback.progress, { attempt: 1, maxAttempts: 2 });
  assert.equal(feedback.issues[0].label, 'Składniki i ilości');
  assert.equal(feedback.primary, undefined);
  assert.equal(readyPreparationAction(3, recovering, null), null);
});

test('a completed repair opens the ready descendant rather than applying the failed parent', () => {
  const repaired: AiJob = { ...job, recovery: { status: 'ready', attempt: 1, maxAttempts: 2, jobId: 'child' } };
  assert.equal(jobHasOngoingWork(repaired), false);
  assert.deepEqual(aiJobFeedback(repaired, 3)?.primary, { action: 'view', label: 'Zobacz gotowy przepis', href: '/admin/ai/child' });
  assert.equal(readyPreparationAction(3, repaired, null), null);
  assert.deepEqual(readyPreparationAction(3, { ...job, id: 'child', status: 'ready' }, null), { action: 'apply_text', jobId: 'child' });
});

test('exhausted repairs direct the admin to improve instructions and never offer a blind retry', () => {
  const exhausted: AiJob = { ...job, recovery: { status: 'exhausted', attempt: 2, maxAttempts: 2, canResume: false, issues: [{ field: 'recipe.slug.pl', message: 'Invalid input: expected string, received undefined' }] } };
  const feedback = aiJobFeedback(exhausted, 3)!;
  assert.equal(feedback.primary?.action, 'edit');
  assert.equal(feedback.progress?.attempt, 2);
  assert.equal(feedback.issues[0].label, 'Tytuł przepisu');
  assert.match(feedback.issues[0].message, /Brakuje wymaganej informacji/);
  assert.equal(jobHasOngoingWork(exhausted), false);
});

test('an exhausted server-confirmed receipt offers only an explicit saved-result recheck', () => {
  const exhausted: AiJob = { ...job, recovery: { status: 'exhausted', attempt: 2, maxAttempts: 2,
    jobId: 'last-repair', canResume: true, issues: [{ field: 'ingredients.nori.name', message: 'Unrecognised ingredient.' }] } };
  const feedback = aiJobFeedback(exhausted, 3)!;
  assert.deepEqual(feedback.primary, { action: 'recover', label: 'Sprawdź zapisany wynik' });
  assert.match(feedback.description, /dwie automatyczne poprawki/);
  assert.match(feedback.description, /bez kolejnej generacji/);
  assert.match(feedback.description, /Jeśli nadal zawiera błędy, popraw wskazówki/);
  assert.deepEqual(feedback.progress, { attempt: 2, maxAttempts: 2 });
  assert.equal(canStartNewRecipeText(exhausted, 3), false);
  assert.equal(aiJobFeedback(exhausted, 4)!.primary!.action, 'edit', 'A changed draft cannot re-read and apply an old input.');
  assert.equal(jobHasOngoingWork(exhausted), false);
});

test('the server canResume flag is required to continue legacy invalid jobs', () => {
  assert.notEqual(aiJobFeedback(job, 3)?.primary?.action, 'recover');
  const resumable: AiJob = { ...job, recovery: { status: 'blocked', attempt: 0, maxAttempts: 2, canResume: true, reason: 'Można sprawdzić istniejący wynik.' } };
  assert.equal(aiJobFeedback(resumable, 3)?.primary?.action, 'recover');
  assert.equal(aiJobFeedback({ ...resumable, recovery: { ...resumable.recovery!, canResume: false } }, 3)?.primary?.action, 'edit');
  assert.equal(aiJobFeedback(resumable, 4)?.primary?.action, 'edit');
});

test('configuration, budget, and uncertain receipt problems have different concrete actions', () => {
  assert.equal(aiJobFeedback({ ...job, errorCode: 'AI_AUTH' }, 3)?.primary?.href, '/admin/settings');
  assert.match(aiJobFeedback({ ...job, errorCode: 'AI_BUDGET_EXCEEDED' }, 3)!.title, /budżetu/);
  assert.equal(aiJobFeedback({ ...job, status: 'uncertain' }, 3)?.primary?.action, 'resume');
  assert.equal(aiJobFeedback({ ...job, status: 'uncertain', providerRequestId: null }, 3)?.primary?.action, 'refresh');
  assert.equal(aiJobFeedback({ ...job, status: 'uncertain' }, 4)?.primary?.action, 'resume');
  assert.equal(aiJobFeedback({ ...job, recovery: { status: 'blocked', attempt: 0, maxAttempts: 2, reason: 'Brak dostępnego budżetu.', code: 'BUDGET_LIMIT', canResume: false } }, 3)?.primary?.action, 'settings');
});

test('ready text still requires manual acceptance and photo jobs retain their existing controls', () => {
  assert.equal(aiJobFeedback({ ...job, status: 'ready' }, 3), null);
  assert.equal(aiJobFeedback({ ...job, status: 'applied' }, 4), null);
  assert.equal(aiJobFeedback({ ...job, kind: 'hero' }, 3), null);
  assert.equal(recipeIssueLabel('sources.0.url'), 'Źródła i research');
});

test('unchanged invalid and uncertain jobs cannot bypass bounded recovery with a new generation', () => {
  assert.equal(canStartNewRecipeText(job, 3), false);
  assert.equal(canStartNewRecipeText({ ...job, status: 'uncertain' }, 3), false);
  assert.equal(canStartNewRecipeText({ ...job, recovery: { status: 'exhausted', attempt: 2, maxAttempts: 2, canResume: false } }, 3), false);
  assert.equal(canStartNewRecipeText(job, 4), true);
  assert.equal(canStartNewRecipeText({ ...job, errorCode: 'AI_CONFIGURATION' }, 3), true);
  assert.equal(canStartNewRecipeText(null, 3), true);
});

test('a durable pause code overrides the original invalid-result error without parsing the explanation', () => {
  const blocked = { ...job, recovery: { status: 'blocked' as const, attempt: 1, maxAttempts: 2, canResume: true, reason: 'Dalsza praca została wstrzymana.' } };
  for (const code of ['BUDGET_LIMIT', 'TREND_BUDGET_LIMIT', 'TREND_PACKET_LIMIT']) {
    const feedback = aiJobFeedback({ ...blocked, recovery: { ...blocked.recovery, code } }, 3)!;
    assert.equal(feedback.primary?.action, 'settings');
    assert.match(feedback.title, /budżetu/);
    assert.equal(feedback.progress?.attempt, 1);
  }
  for (const code of ['STALE_RESULT', 'RECIPE_REPAIR_STALE']) {
    const feedback = aiJobFeedback({ ...blocked, recovery: { ...blocked.recovery, code } }, 3)!;
    assert.equal(feedback.primary?.action, 'edit');
    assert.match(feedback.title, /zmienił się/);
  }
  const changed = aiJobFeedback({ ...blocked, recovery: { ...blocked.recovery, code: 'RECIPE_MODEL_CHANGED' } }, 3)!;
  assert.equal(changed.primary?.action, 'edit');
  assert.match(changed.title, /konfiguracja/);
  assert.equal(changed.progress?.attempt, 1);
});

test('photo correction stays a separate manual review and preserves the original job status', () => {
  const photo: AiJob = { ...job, kind: 'hero', status: 'failed', errorCode: 'AI_TRANSPARENCY_MISSING',
    photoRecovery: { jobId: 'mask', status: 'generating', chargedUsd: null, costBasis: null, errorCode: null } };
  assert.equal(jobHasOngoingWork(photo), true);
  assert.equal(aiJobFeedback(photo)?.tone, 'working');
  assert.equal(aiJobFeedback(photo)?.primary?.href, '/admin/ai/mask');
  const ready: AiJob = { ...photo, photoRecovery: { ...photo.photoRecovery!, status: 'ready', chargedUsd: '0.005', costBasis: 'usage' } };
  assert.equal(jobHasOngoingWork(ready), false);
  assert.equal(aiJobFeedback(ready)?.tone, 'success');
  assert.equal(aiJobFeedback(ready)?.primary?.action, 'view');
  assert.equal(ready.status, 'failed');
  assert.equal(readyPreparationAction(3, ready, null), null);
});

test('photo admission grace polls only recent transparency failures and stops after two minutes', () => {
  const now = Date.parse('2026-10-20T19:00:00Z');
  const photo: AiJob = { ...job, kind: 'hero', status: 'failed', errorCode: 'AI_TRANSPARENCY_MISSING', updatedAt: new Date(now - 10_000).toISOString() };
  assert.equal(photoRecoveryPollInterval(photo, now), 4000);
  assert.equal(photoRecoveryPollInterval(photo, now + 120_000), null);
  assert.equal(photoRecoveryPollInterval({ ...photo, errorCode: 'AI_PROVIDER_REJECTED' }, now), null);
  assert.equal(photoRecoveryPollInterval({ ...photo, updatedAt: 'invalid' }, now), null);
  assert.equal(photoRecoveryPollInterval({ ...photo, providerRequestId: null }, now), null);
  assert.equal(photoRecoveryPollInterval({ ...photo, photoRecovery: { jobId: 'mask', status: 'failed', chargedUsd: '0.005', costBasis: 'usage', errorCode: 'AI_MASK_NOT_FOUND' } }, now), null);
});

test('background and format failures do not present a completed photo as a fatal photography failure', () => {
  const photo: AiJob = { ...job, kind: 'hero', errorCode: 'AI_TRANSPARENCY_MISSING' };
  assert.match(aiJobFeedback(photo)!.title, /Zdjęcie powstało/);
  assert.match(aiJobFeedback({ ...photo, status: 'generating', model: 'fal-ai/sam-3/image' })!.title, /Przygotowujemy tło/);
  assert.match(aiJobFeedback({ ...photo, model: 'fal-ai/sam-3/image', errorCode: 'AI_MASK_NOT_FOUND' })!.title, /Wycięcie tła/);
  assert.match(aiJobFeedback({ ...photo, model: 'jesie/step-photo-21-9', errorCode: 'AI_IMAGE_FORMAT_FAILED' })!.title, /Formatowanie/);
  assert.equal(aiJobFeedback({ ...photo, errorCode: 'AI_PROVIDER_REJECTED' }), null);
});

test('only a server-confirmed retained mask offers free restoration through its existing receipt', () => {
  const mask: AiJob = { ...job, kind: 'hero', model: 'fal-ai/sam-3/image', status: 'failed', errorCode: 'AI_IMAGE_INVALID' };
  assert.equal(aiJobFeedback(mask)?.primary, undefined);
  const restore = aiJobFeedback({ ...mask, canRestorePhotoContents: true })!;
  assert.equal(restore.primary?.action, 'resume');
  assert.equal(restore.primary?.label, 'Przywróć potrawę z oryginału');
  assert.match(restore.description, /istniejącego wyniku/);
  assert.match(restore.description, /kolejnej płatnej maski/);
  assert.equal(jobHasOngoingWork({ ...mask, canRestorePhotoContents: true }), false);
  assert.equal(aiJobFeedback({ ...mask, canRestorePhotoContents: true, status: 'ready' }), null);
});
