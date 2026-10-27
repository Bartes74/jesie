'use client';

import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import { formatRecipeDuration } from '@/lib/recipe-duration';
import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, Eye, ImagePlus, LoaderCircle, RefreshCw, Settings2, Sparkles } from 'lucide-react';
import { MediaImage } from '@/components/MediaImage';
import { RecipePhoto } from '@/components/RecipePhoto';
import { RecipePreviewFrame } from '@/components/admin/RecipePreviewFrame';
import { InlineRecipeCorrection } from '@/components/admin/InlineRecipeCorrection';
import { RecipeHeroPresentationEditor } from '@/components/admin/RecipeHeroPresentationEditor';
import { heroPresentationIssue, heroPresentationProfile, resolveHeroPresentationForBrief, suggestHeroPresentation } from '@/lib/hero-presentation';
import type { HeroPresentationReview } from '@/lib/hero-presentation-review';
import { RecipePhotoEditor, type PhotoEditorLock } from '@/components/admin/RecipePhotoEditor';
import type { RecipeCorrection } from '@/lib/recipe-correction';
import { reviewKeys, type ReviewChecks } from '@/lib/editorial-types';
import { JobRecoveryNotice } from '@/components/admin/JobRecoveryNotice';
import { canStartNewRecipeText, jobHasOngoingWork } from '@/lib/ai-job-feedback';
import { formatIngredientAmount, renderStepText } from '@/lib/quantities';
import { formatSubstitutionAmount } from '@/lib/pantry';
import type { EditorialRecord, PublicationIssue } from '@/lib/editorial-types';
import type { AiJob } from '@/lib/ai-types';
import type { AiPhotoBatch } from '@/lib/ai-photo-batch-types';
import type { IngredientSubstitution, Locale, Recipe } from '@/lib/recipes';
import { generationRequest, readPendingPreparation, readyPreparationAction, type PendingPreparationRequest } from '@/lib/preparation-client';
import { previewReviewChannel, readRecipePreviewReady, recipePreviewUrl, type RecipePreviewScope } from '@/lib/recipe-preview';

type Preparation = { recipe: EditorialRecord; textJob: AiJob | null; photoBatch: AiPhotoBatch | null; contentApproved: boolean; blockingGeneration: boolean; photoBatchCompatible: boolean };
type Action = 'generate_text' | 'apply_text' | 'approve_content' | 'generate_photos' | 'apply_photos' | 'publish';
type PendingRequest = PendingPreparationRequest;
const textActive = jobHasOngoingWork;
const photosActive = (batch: AiPhotoBatch | null) => Boolean(batch && ['queued', 'generating'].includes(batch.status));
const safeError = (value: string) => value.replace(/OpenAI(?: API)?/g, 'generator treści').replace(/fal\.ai/g, 'generator zdjęć');
const previewStorageKey = (recipeId: string, revision: number) => `jesie:preview-review:v1:${recipeId}:${revision}`;
function storedPreviewLanguages(recipeId: string, revision: number): Locale[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(previewStorageKey(recipeId, revision)) ?? '[]');
    return Array.isArray(value) && value.length <= 2 ? value.filter((item): item is Locale => item === 'pl' || item === 'en') : [];
  } catch { return []; }
}

function amountLabel(recipe: Recipe, index: number, locale: Locale) {
  try { return formatIngredientAmount(recipe.ingredients[index], recipe.baseServings, recipe.baseServings, 'metric', locale); }
  catch { return 'Sprawdź ilość'; }
}

function methodText(recipe: Recipe, index: number, locale: Locale) {
  try { return renderStepText(recipe.steps[index], recipe, recipe.baseServings, 'metric', locale); }
  catch { return formatRecipeDurationText(recipe.steps[index].text[locale], locale); }
}

function substitutionAmount(recipe: Recipe, substitution: IngredientSubstitution, locale: Locale) {
  try { return formatSubstitutionAmount(substitution, recipe.baseServings, recipe.baseServings, 'metric', locale); }
  catch { return 'Sprawdź ilość zamiennika'; }
}

function ContentReview({ recipe, locale, notes = [], onCorrect, disabled, children }: { recipe: Recipe; locale: Locale; notes?: string[]; onCorrect: (correction: RecipeCorrection) => void; disabled: boolean; children?: ReactNode }) {
  return <div className="guided-content-review">
    <p className="guided-description">{formatRecipeDurationText(recipe.description[locale], locale)}</p>
    <div className="guided-recipe-meta"><span>{recipe.baseServings} porcji</span><span><Clock3 size={15} />{formatRecipeDuration(recipe.times.total, locale)}</span><span>{locale === 'pl' ? 'Praca' : 'Hands-on'}: {formatRecipeDuration(recipe.times.active, locale)}</span></div>
    <div className="guided-review-columns"><section><h3>Składniki</h3><ul className="guided-ingredients">{recipe.ingredients.map((ingredient, index) => <li key={ingredient.id}><strong>{amountLabel(recipe, index, locale)}</strong><span>{ingredient.name[locale]}{ingredient.note?.[locale] ? <small>{formatRecipeDurationText(ingredient.note[locale], locale)}</small> : null}</span><button type="button" className="admin-text-link" disabled={disabled} onClick={() => onCorrect({ kind: 'ingredient', item: ingredient })}>Popraw</button></li>)}</ul></section><section><h3>Przygotowanie</h3><ol className="guided-method">{recipe.steps.map((step, index) => <li key={step.id}><span>{index + 1}</span><div><h4>{step.title[locale]}</h4><p>{methodText(recipe, index, locale)}</p><button type="button" className="admin-text-link" disabled={disabled} onClick={() => onCorrect({ kind: 'step', item: step })}>Popraw krok</button></div></li>)}</ol></section></div>
    {recipe.scalingNote?.[locale] && <section className="guided-review-note"><h3>Zmiana liczby porcji</h3><p>{formatRecipeDurationText(recipe.scalingNote[locale], locale)}</p></section>}
    {(recipe.substitutions?.length ?? 0) > 0 && <section className="guided-review-note"><h3>Zamienniki</h3><p>Sprawdź proponowane zamiany i ich wpływ na smak, konsystencję oraz przygotowanie.</p><ul className="guided-substitutions">{recipe.substitutions!.map(substitution => {
      const ingredient = recipe.ingredients.find(item => item.id === substitution.ingredientId);
      const amount = substitutionAmount(recipe, substitution, locale);
      return <li key={substitution.id}><strong>{ingredient?.name[locale] || 'Nieznany składnik'} → {substitution.name[locale] || substitution.name.en}{amount ? ` · ${amount}` : ''}</strong><p>{formatRecipeDurationText(substitution.note[locale], locale)}</p></li>;
    })}</ul></section>}
    {recipe.equipment[locale].length > 0 && <section className="guided-review-note"><h3>Potrzebny sprzęt</h3><p>{recipe.equipment[locale].join(', ')}</p></section>}
    {recipe.tips[locale].length > 0 && <section className="guided-review-note"><h3>Wskazówki</h3><ul>{recipe.tips[locale].map((tip, index) => <li key={index}>{formatRecipeDurationText(tip, locale)}</li>)}</ul></section>}
    {recipe.storage[locale] && <section className="guided-review-note"><h3>Przechowywanie</h3><p>{formatRecipeDurationText(recipe.storage[locale], locale)}</p></section>}
    {notes.length > 0 && <section className="guided-review-note"><h3>Założenia i korekty</h3><ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
    {children}
  </div>;
}

export function GuidedRecipeEditor({ initialRecipe, autoGenerate = false }: { initialRecipe: EditorialRecord; autoGenerate?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<Preparation>({ recipe: initialRecipe, textJob: null, photoBatch: null, contentApproved: false, blockingGeneration: false, photoBatchCompatible: false });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Action | 'refresh' | 'recover' | 'resume' | 'save_instructions' | null>(null);
  const [error, setError] = useState('');
  const [actionIssues, setActionIssues] = useState<PublicationIssue[]>([]);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [previewLocale, setPreviewLocale] = useState<Locale>('pl');
  const [contentLocale, setContentLocale] = useState<Locale>('pl');
  const [correction, setCorrection] = useState<RecipeCorrection | null>(null);
  const [photoEditorLock, setPhotoEditorLock] = useState<PhotoEditorLock>({ busy: false, dirty: false, pending: false });
  const [heroDraft, setHeroDraft] = useState<{ recipeId: string; revision: number; value: HeroPresentationReview } | null>(null);
  const [contentSeen, setContentSeen] = useState<string[]>([]);
  const [previewSeen, setPreviewSeen] = useState<string[]>([]);
  const [previewScope, setPreviewScope] = useState<RecipePreviewScope | null>(null);
  const [contentConfirmation, setContentConfirmation] = useState<number | null>(null);
  const [review, setReview] = useState<{ revision: number; checks: ReviewChecks }>({ revision: initialRecipe.revision, checks: { pl: false, en: false, quantities: false, method: false, photos: false, sources: false } });
  const [instructions, setInstructions] = useState<{ title: string; originalText: string; expectedRevision: number } | null>(null);
  const stateRef = useRef(state);
  const busyRef = useRef(false);
  const autoStarted = useRef(false);
  const pendingRef = useRef<PendingRequest | null>(null);
  const autoApplied = useRef(new Set<string>());
  const endpoint = `/api/admin/recipes/${encodeURIComponent(initialRecipe.id)}/preparation`;
  const recipeUrl = `/admin/recipes/${encodeURIComponent(initialRecipe.id)}`;
  const storageKey = `jesie:preparation-pending:v1:${initialRecipe.id}`;

  const accept = useCallback((next: Preparation) => {
    if (next.recipe.revision < stateRef.current.recipe.revision) return;
    stateRef.current = next;
    setState(next);
    setLoaded(true);
  }, []);

  const savePending = useCallback((next: PendingRequest | null) => {
    pendingRef.current = next;
    setPending(next);
    try { if (next) sessionStorage.setItem(storageKey, JSON.stringify(next)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory idempotency remains available. */ }
  }, [storageKey]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { cache: 'no-store', signal });
    const body = await response.json();
    if (!response.ok || !body.recipe) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się wczytać przepisu.');
    if (!signal?.aborted) accept(body);
    return body as Preparation;
  }, [endpoint, accept]);

  const perform = useCallback(async (action: Action, extra: { jobId?: string; batchId?: string; heroPresentation?: HeroPresentationReview } = {}) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action); setError(''); setActionIssues([]); setNotice('');
    let request: { action: Action; expectedRevision: number; requestKey?: string; jobId?: string; batchId?: string; checks?: ReviewChecks; heroPresentation?: HeroPresentationReview } = { action, expectedRevision: stateRef.current.recipe.revision, ...extra };
    if (action === 'publish') request = { ...request, checks: review.revision === stateRef.current.recipe.revision ? review.checks : undefined };
    if (action === 'generate_text' || action === 'generate_photos') {
      if (pendingRef.current && pendingRef.current.action !== action) { setError('Najpierw sprawdź poprzednie zgłoszenie.'); busyRef.current = false; setBusy(null); return; }
      const saved = pendingRef.current ?? { version: 1 as const, action, expectedRevision: stateRef.current.recipe.revision, requestKey: crypto.randomUUID() };
      savePending(saved);
      request = generationRequest(saved);
    }
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const body = await response.json();
      if (!response.ok || !body.recipe) {
        if (Array.isArray(body.issues)) setActionIssues(body.issues.filter((issue: PublicationIssue) => typeof issue?.message === 'string'));
        if (response.status === 409) setConflict(true);
        if (response.status >= 400 && response.status < 500) savePending(null);
        throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się potwierdzić operacji. Odśwież stan przed kolejnym działaniem.');
      }
      accept(body); savePending(null); setConflict(false);
      if (action === 'approve_content') { setHeroDraft(null); setNotice('Treść zaakceptowana. Możesz teraz wygenerować brakujące grafiki.'); }
      if (action === 'apply_text') setNotice('Przepis jest gotowy do przeczytania. Sprawdź składniki, proporcje i sposób przygotowania.');
      if (action === 'apply_photos') setNotice('Grafiki są zapisane. Sprawdź gotowy przepis w podglądzie.');
      if (action === 'publish') { setNotice('Przepis jest opublikowany w serwisie.'); router.refresh(); }
      if (action === 'generate_text' && autoGenerate) router.replace(recipeUrl, { scroll: false });
    } catch (err) {
      setError(err instanceof Error ? safeError(err.message) : 'Nie udało się połączyć z serwisem.');
    } finally { busyRef.current = false; setBusy(null); }
  }, [accept, autoGenerate, endpoint, recipeUrl, router, savePending, review]);

  useEffect(() => {
    let saved: PendingRequest | null = null;
    try {
      saved = readPendingPreparation(sessionStorage.getItem(storageKey));
      pendingRef.current = saved;
    } catch { /* A new request can still be made explicitly. */ }
    const controller = new AbortController();
    void load(controller.signal).then(() => { if (!controller.signal.aborted) setPending(saved); }).catch(err => {
      if (!controller.signal.aborted) { setPending(saved); setError(err instanceof Error ? safeError(err.message) : 'Nie udało się wczytać przepisu.'); }
    });
    return () => controller.abort();
  }, [load, storageKey]);

  const { recipe: record, textJob, photoBatch, contentApproved: savedContentApproved, blockingGeneration, photoBatchCompatible } = state;
  const recipe = record.content.recipe;
  const readonly = Boolean(record.deletedAt) || record.editorialStatus === 'archived';
  const generatingText = textActive(textJob);
  const generatingPhotos = photosActive(photoBatch);
  const active = generatingText || generatingPhotos || blockingGeneration;
  const otherGeneration = blockingGeneration && !generatingText && !generatingPhotos;
  const hasText = recipe.ingredients.length > 0 && recipe.steps.length > 0 && Boolean(recipe.description.pl.trim());
  const missingIngredients = recipe.ingredients.filter(item => !record.content.photos.ingredients[item.id]?.src).length;
  const missingSteps = recipe.steps.filter(item => isStepPhotoRequired(record.content, item.id) && !record.content.photos.steps[item.id]?.src).length;
  const allPhotos = hasText && Boolean(recipe.image) && missingIngredients === 0 && missingSteps === 0;
  const photoRequestOpen = photoEditorLock.busy || photoEditorLock.pending;
  const photoEditorOpen = photoRequestOpen;
  const proposedPresentation = resolveHeroPresentationForBrief(recipe, '') ?? suggestHeroPresentation(recipe);
  const originalPresentation: HeroPresentationReview | null = proposedPresentation ? { container: proposedPresentation.container, finalAppearance: proposedPresentation.finalAppearance } : null;
  const currentHeroDraft = heroDraft?.recipeId === record.id ? heroDraft : null;
  const heroPresentation = currentHeroDraft?.value ?? originalPresentation;
  const heroDirty = currentHeroDraft !== null && JSON.stringify(currentHeroDraft.value) !== JSON.stringify(originalPresentation);
  const staleHeroDraft = heroDirty && currentHeroDraft.revision !== record.revision;
  const contentApproved = savedContentApproved && !heroDirty;
  const presentationIssue = heroPresentationIssue(recipe, heroPresentation ? { ...heroPresentation, profileVersion: heroPresentationProfile, evidenceStepIds: recipe.steps.map(step => step.id) } : null);
  const frozen = Boolean(busy) || !loaded || conflict || readonly || Boolean(pending) || Boolean(correction) || photoEditorOpen;
  const textNeedsAttention = textJob?.recovery?.status !== undefined || textJob?.status === 'failed' || textJob?.status === 'uncertain' || textJob?.status === 'cancelled';
  const photosNeedAttention = photoBatch?.status === 'failed' || photoBatch?.status === 'blocked';
  const canStartText = canStartNewRecipeText(textJob, record.revision);
  const publishedCurrent = record.publicationStatus === 'published' && record.publishedRevision === record.revision;
  const showPreview = allPhotos && contentApproved;
  const currentStage = !contentApproved ? 0 : !allPhotos || generatingPhotos ? 1 : 2;
  const researchNotes = (textJob?.result?.notes ?? []).map(note => note.trim()).filter(note => note && !/^Przed publikacją sprawdź proporcje, metodę, oba języki i zgodność fotografii\.?$/i.test(note));
  const bothContentLanguagesSeen = contentSeen.includes(`${record.revision}:pl`) && contentSeen.includes(`${record.revision}:en`);
  const plPreviewSeen = previewSeen.includes(`${record.revision}:pl`);
  const enPreviewSeen = previewSeen.includes(`${record.revision}:en`);
  const bothPreviewLanguagesSeen = plPreviewSeen && enPreviewSeen;
  const currentPreviewScope = previewScope?.recipeId === record.id && previewScope.revision === record.revision ? previewScope : null;
  const checks = review.revision === record.revision ? review.checks : { pl: false, en: false, quantities: false, method: false, photos: false, sources: false };
  const allChecks = reviewKeys.every(key => checks[key]);
  const previewReady = useCallback((locale: Locale, revision: number) => {
    const currentRecipe = stateRef.current.recipe;
    if (revision !== currentRecipe.revision) return;
    setPreviewSeen(current => current.includes(`${revision}:${locale}`) ? current : [...current, `${revision}:${locale}`]);
    try {
      const languages = new Set([...storedPreviewLanguages(currentRecipe.id, revision), locale]);
      sessionStorage.setItem(previewStorageKey(currentRecipe.id, revision), JSON.stringify([...languages]));
    } catch { /* The current tab can still confirm its preview in memory. */ }
  }, []);
  useEffect(() => {
    const scope = { recipeId: record.id, revision: record.revision, token: crypto.randomUUID() };
    let disposed = false;
    const receive = (value: unknown) => {
      if (disposed) return;
      const ready = readRecipePreviewReady(value, scope);
      if (ready) previewReady(ready.locale, ready.revision);
    };
    const embedded = (event: MessageEvent) => { if (event.origin === window.location.origin) receive(event.data); };
    window.addEventListener('message', embedded);
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(previewReviewChannel(scope.token));
      channel.onmessage = event => receive(event.data);
    } catch { /* Same-origin embedded previews also use postMessage and document inspection. */ }
    queueMicrotask(() => {
      if (disposed) return;
      setPreviewScope(scope);
      const restored = storedPreviewLanguages(scope.recipeId, scope.revision).map(locale => `${scope.revision}:${locale}`);
      setPreviewSeen(current => [...new Set([...current, ...restored])]);
    });
    return () => { disposed = true; channel?.close(); window.removeEventListener('message', embedded); };
  }, [record.id, record.revision, previewReady]);
  useEffect(() => {
    if (!heroDirty) return;
    const beforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeLeave);
    return () => window.removeEventListener('beforeunload', beforeLeave);
  }, [heroDirty]);
  const publishBlockReason = !loaded ? 'Wczytuję aktualny stan przepisu.'
    : busy ? 'Trwa zapisywanie. Poczekaj na potwierdzenie.'
    : conflict ? 'Przepis zmienił się. Odśwież jego stan.'
    : readonly ? 'Przywróć przepis z archiwum lub Kosza przed publikacją.'
    : pending ? 'Najpierw sprawdź wynik oczekującego zgłoszenia powyżej.'
    : correction ? 'Zapisz lub zamknij otwartą poprawkę.'
    : photoEditorOpen ? 'Sprawdź oczekujące zgłoszenie zdjęcia.'
    : heroDirty ? 'Zaakceptuj treść z bieżącym naczyniem i opisem zdjęcia.'
    : active ? 'Trwa przygotowanie materiałów. Poczekaj na zakończenie lub sprawdź zgłoszenie powyżej.'
    : instructions ? 'Zapisz i zamknij otwarte wskazówki do przepisu.'
    : !showPreview ? 'Najpierw zaakceptuj treść i uzupełnij grafiki.'
    : record.issues.length ? `Przed publikacją popraw wskazane problemy: ${record.issues.length}.`
    : !bothPreviewLanguagesSeen ? `Wczytaj jeszcze podgląd: ${[!plPreviewSeen && 'polski', !enPreviewSeen && 'angielski'].filter(Boolean).join(' i ')}. Użyj przycisków języka przy podglądzie albo otwórz pełny podgląd i wróć do panelu.`
    : !allChecks ? 'Oba podglądy są wczytane. Po sprawdzeniu przepisu zaznacz potwierdzenie poniżej, aby odblokować publikację.'
    : 'Możesz opublikować przepis.';
  const correctionSaved = useCallback((next: EditorialRecord) => { accept({ ...stateRef.current, recipe: next, contentApproved: false }); setError(''); setActionIssues([]); setNotice(''); setContentConfirmation(null); }, [accept]);
  const reloadPhotoContext = useCallback(async () => (await load()).recipe, [load]);
  useEffect(() => {
    if (!hasText) return;
    const key = `${record.revision}:${contentLocale}`;
    queueMicrotask(() => setContentSeen(current => current.includes(key) ? current : [...current, key]));
  }, [contentLocale, hasText, record.revision]);


  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let disposed = false;
    const poll = async () => {
      if (disposed) return;
      if (!document.hidden && !busyRef.current) {
        controller = new AbortController();
        try { await load(controller.signal); }
        catch (err) { if (!disposed) setError(err instanceof Error ? safeError(err.message) : 'Nie udało się odświeżyć postępu.'); }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 10_000);
    };
    timer = setTimeout(() => void poll(), 10_000);
    return () => { disposed = true; if (timer) clearTimeout(timer); controller?.abort(); };
  }, [active, load]);

  useEffect(() => {
    if (!loaded || !autoGenerate || autoStarted.current || readonly || conflict || active || busyRef.current) return;
    autoStarted.current = true;
    if (pendingRef.current) return;
    if (!hasText && !textJob) void perform('generate_text');
  }, [active, autoGenerate, conflict, hasText, loaded, perform, readonly, textJob]);

  useEffect(() => {
    if (!loaded || conflict || readonly || busy || pending || blockingGeneration || correction || photoEditorOpen || heroDirty) return;
    const next = readyPreparationAction(record.revision, textJob, photoBatch, photoBatchCompatible);
    if (!next) return;
    const key = `${next.action}:${'jobId' in next ? next.jobId : next.batchId}:${record.revision}`;
    if (!autoApplied.current.has(key)) { autoApplied.current.add(key); void perform(next.action, 'jobId' in next ? { jobId: next.jobId } : { batchId: next.batchId }); }
  }, [blockingGeneration, busy, conflict, correction, loaded, pending, perform, photoBatch, photoBatchCompatible, photoEditorOpen, heroDirty, readonly, record.revision, textJob]);

  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('refresh'); setError(''); setActionIssues([]);
    try { await load(); setConflict(false); }
    catch (err) { setError(err instanceof Error ? safeError(err.message) : 'Nie udało się odświeżyć przepisu.'); }
    finally { busyRef.current = false; setBusy(null); }
  };

  const recoverText = async (action: 'recover' | 'resume') => {
    const current = stateRef.current.textJob;
    if (busyRef.current || !current) return;
    busyRef.current = true; setBusy(action); setError(''); setNotice(''); setActionIssues([]);
    try {
      const response = await fetch(`/api/admin/ai/${encodeURIComponent(current.id)}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const body = await response.json();
      if (!response.ok || !body.job) {
        if (response.status === 409) setConflict(true);
        throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się potwierdzić stanu zgłoszenia. Odśwież stan i sprawdź ponownie.');
      }
      await load();
      setNotice('Stan przygotowania jest aktualny. Gotowy przepis pokażemy do przeczytania i akceptacji.');
    } catch (err) { setError(err instanceof Error ? safeError(err.message) : 'Nie udało się sprawdzić zgłoszenia.'); }
    finally { busyRef.current = false; setBusy(null); }
  };

  const saveInstructions = async () => {
    if (busyRef.current || !instructions || !instructions.title.trim()) return;
    busyRef.current = true; setBusy('save_instructions'); setError(''); setNotice(''); setActionIssues([]);
    const content = structuredClone(stateRef.current.recipe.content);
    content.recipe.title.pl = instructions.title.trim();
    content.originalText = instructions.originalText;
    try {
      const response = await fetch(`/api/admin/recipes/${encodeURIComponent(record.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: instructions.expectedRevision, content }) });
      const body = await response.json();
      if (!response.ok || !body.recipe) {
        if (response.status === 409) setConflict(true);
        throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się zapisać wskazówek.');
      }
      setInstructions(null);
      await load();
      setNotice('Wskazówki zapisane. Kliknij „Wygeneruj przepis”, aby przygotować treść na ich podstawie.');
    } catch (err) { setError(err instanceof Error ? safeError(err.message) : 'Nie udało się zapisać wskazówek.'); }
    finally { busyRef.current = false; setBusy(null); }
  };

  const presentationReview = <>
    <RecipeHeroPresentationEditor recipe={recipe} value={heroPresentation} locale={contentLocale} disabled={frozen || active || Boolean(instructions)} onChange={value => {
      setHeroDraft({ recipeId: record.id, revision: record.revision, value }); setContentConfirmation(null); setError(''); setActionIssues([]);
    }} />
    {staleHeroDraft && <p className="admin-inline-error" role="status">Przepis zmienił się. Porównaj opis z aktualną treścią i potwierdź go ponowną edycją przed akceptacją.</p>}
  </>;

  return <div className="guided-editor">
    <div className="guided-topline"><Link href="/admin/recipes" className="admin-text-link"><ArrowLeft size={16} />Przepisy</Link><Link href={`${recipeUrl}?advanced=1`} className="admin-text-link"><Settings2 size={16} />Edytuj szczegóły</Link></div>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">{record.publicationStatus === 'published' ? 'PRZEPIS OPUBLIKOWANY' : 'TWÓJ PRZEPIS'}</p><h1>{recipe.title.pl || recipe.title.en || 'Nowy przepis'}</h1><p>Sprawdź treść, przygotuj grafiki i opublikuj gotowe danie.</p></div><button type="button" className="admin-button is-secondary" onClick={() => void refresh()} disabled={Boolean(busy) || Boolean(correction) || photoEditorOpen} aria-label="Odśwież stan przepisu"><RefreshCw size={16} className={busy === 'refresh' ? 'admin-spinner' : ''} />Odśwież</button></div>
    <ol className="guided-progress" aria-label="Etapy przygotowania przepisu">{['Treść', 'Grafiki', 'Publikacja'].map((label, index) => <li key={label} className={index < currentStage ? 'is-complete' : index === currentStage ? 'is-current' : ''} aria-current={index === currentStage ? 'step' : undefined}><span>{index < currentStage ? <Check size={17} /> : index + 1}</span><strong>{label}</strong></li>)}</ol>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={19} /><div><p>{error}</p>{conflict && <p>Przepis zmienił się w innym miejscu. Wczytaj aktualną wersję przyciskiem „Odśwież”, zanim wykonasz kolejny krok.</p>}{actionIssues.length > 0 && <ul>{actionIssues.map((issue, index) => <li key={`${issue.field}:${index}`}>{issue.message}</li>)}</ul>}</div></div>}
    {notice && <div className="admin-notice is-success" role="status"><CheckCircle2 size={19} /><p>{notice}</p></div>}
    {otherGeneration && <div className="admin-notice" role="status"><LoaderCircle size={19} className="admin-spinner" /><div><p>Przy tym przepisie jest niezakończone zgłoszenie. Sprawdź jego stan przed kolejnym generowaniem lub publikacją. Stan odświeża się automatycznie.</p><Link className="admin-text-link" href={`/admin/ai?recipe=${encodeURIComponent(record.id)}`}>Sprawdź aktywne zlecenie <ArrowRight size={15} /></Link></div></div>}
    {pending && <div className="admin-notice" role="status"><AlertCircle size={19} /><div><p>Nie potwierdzono zakończenia zgłoszenia. Sprawdź je tym samym przyciskiem; zachowamy jego identyfikator.</p><button type="button" className="admin-text-link" disabled={Boolean(busy)} onClick={() => void perform(pending.action)}>Sprawdź zgłoszenie <ArrowRight size={15} /></button></div></div>}
    {readonly ? <section className="admin-section"><h2>{record.deletedAt ? 'Przepis jest w koszu' : 'Przepis jest w archiwum'}</h2><p>Przywróć go w szczegółach, aby kontynuować pracę.</p><Link className="admin-button" href={`${recipeUrl}?advanced=1`}>Otwórz szczegóły</Link></section> : <>
      <section className={`guided-stage ${currentStage === 0 ? 'is-current' : ''}`} aria-labelledby="guided-content-heading">
        <div className="guided-stage-heading"><span className="guided-stage-number">01</span><div><h2 id="guided-content-heading">Sprawdź treść przepisu</h2><p>System uzupełnia przepis w obu językach na podstawie researchu i Twoich wskazówek.</p></div>{contentApproved && <span className="guided-approved"><CheckCircle2 size={17} />Treść zaakceptowana</span>}</div>
        {!loaded && <p className="guided-working" role="status"><LoaderCircle size={19} className="admin-spinner" />Wczytuję stan przygotowania…</p>}
        {generatingText && !textJob?.recovery && <div className="guided-working" role="status"><LoaderCircle size={21} className="admin-spinner" /><div><strong>Przygotowujemy przepis</strong><p>Trwa research i uzupełnianie treści. Możesz opuścić tę stronę i wrócić później.</p></div></div>}
        {textNeedsAttention && textJob && <JobRecoveryNotice job={textJob} currentRevision={record.revision} editHref={`${recipeUrl}?advanced=1`} disabled={frozen || generatingText || generatingPhotos} busy={busy === 'recover' || busy === 'resume'} onRecover={() => void recoverText('recover')} onResume={() => void recoverText('resume')} onRefresh={() => void refresh()} onEdit={textJob.recovery?.status === 'exhausted' ? () => setInstructions({ title: recipe.title.pl, originalText: record.content.originalText, expectedRevision: record.revision }) : undefined} />}
        {instructions && <form className="guided-instructions-form" onSubmit={event => { event.preventDefault(); void saveInstructions(); }}><h3>Doprecyzuj wskazówki</h3><p>Uzupełnij brakujące informacje z listy powyżej. Zapisanie wskazówek nie uruchamia generowania; przygotowanie nowej treści rozpoczniesz osobnym przyciskiem.</p><label className="admin-field">Tytuł przepisu<input required maxLength={200} value={instructions.title} disabled={Boolean(busy)} onChange={event => setInstructions({ ...instructions, title: event.target.value })} /></label><label className="admin-field">Opis lub pełny przepis<textarea rows={9} maxLength={100000} value={instructions.originalText} disabled={Boolean(busy)} onChange={event => setInstructions({ ...instructions, originalText: event.target.value })} /></label><div className="guided-stage-actions"><button type="button" className="admin-button is-secondary" disabled={Boolean(busy)} onClick={() => setInstructions(null)}>Zamknij</button><button type="submit" className="admin-button" disabled={frozen || active || !instructions.title.trim()}>{busy === 'save_instructions' && <LoaderCircle size={16} className="admin-spinner" />}Zapisz wskazówki</button></div></form>}
        {textJob?.status === 'ready' && textJob.baseRevision !== record.revision && <div className="admin-notice" role="status"><AlertCircle size={18} /><div><p>Gotowa propozycja dotyczy wcześniejszej wersji przepisu. Nie zastąpiliśmy Twoich zmian.</p><Link className="admin-text-link" href={`/admin/ai/${encodeURIComponent(textJob.id)}`}>Porównaj propozycję z bieżącą treścią <ArrowRight size={15} /></Link></div></div>}
        {hasText && <div className="admin-locale-tabs" aria-label="Język przeglądu treści"><button type="button" aria-pressed={contentLocale === 'pl'} disabled={Boolean(correction)} onClick={() => setContentLocale('pl')}>Polski</button><button type="button" aria-pressed={contentLocale === 'en'} disabled={Boolean(correction)} onClick={() => setContentLocale('en')}>English</button></div>}
        {correction && <InlineRecipeCorrection key={`${correction.kind}:${correction.item.id}`} record={record} initial={correction} locale={contentLocale} onSaved={correctionSaved} onClose={() => { setCorrection(null); void refresh(); }} />}
        {hasText ? savedContentApproved ? <details className="guided-approved-content"><summary>Pokaż zaakceptowaną treść</summary><ContentReview recipe={recipe} locale={contentLocale} notes={researchNotes} onCorrect={setCorrection} disabled={frozen || active}>{presentationReview}</ContentReview></details> : <ContentReview recipe={recipe} locale={contentLocale} notes={researchNotes} onCorrect={setCorrection} disabled={frozen || active}>{presentationReview}</ContentReview> : !generatingText && <div className="guided-start"><Sparkles size={27} /><p>{record.content.originalText ? 'Twoje wskazówki są zapisane. Przygotujemy pełny przepis i uzupełnimy brakujące informacje.' : 'Tytuł wystarczy, żeby zacząć. Przygotujemy składniki, kroki, czasy i praktyczne wskazówki.'}</p></div>}
        {record.content.sources.length > 0 && <details className="guided-sources"><summary>Źródła i research ({record.content.sources.length})</summary><ul>{record.content.sources.map(source => <li key={source.id}><a href={/^https?:\/\//i.test(source.url) ? source.url : '#'} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
        {record.content.originalText && <details className="guided-sources"><summary>Twoja oryginalna treść</summary><p className="guided-original">{record.content.originalText}</p></details>}
        {hasText && !contentApproved && presentationIssue && <p className="guided-stage-hint" role="status">Sprawdź naczynie i opis zdjęcia w treści powyżej.</p>}
        {hasText && !contentApproved && <p className="guided-stage-hint">Akceptacja obejmuje cały przepis, naczynie i wygląd potrawy, proponowane zamienniki oraz opisane założenia i korekty.</p>}
        {hasText && !contentApproved && <label className="admin-checkbox"><input type="checkbox" checked={contentConfirmation === record.revision} disabled={frozen || active || !bothContentLanguagesSeen || staleHeroDraft} onChange={event => setContentConfirmation(event.target.checked ? record.revision : null)} /><span>Sprawdziłem treść PL i EN, ilości, sposób przygotowania, naczynie i wygląd potrawy oraz zamienniki.{!bothContentLanguagesSeen && ' Otwórz najpierw obie wersje językowe powyżej.'}</span></label>}
        <div className="guided-stage-actions">{hasText ? <><Link href={`${recipeUrl}?advanced=1`} className="admin-button is-secondary">Popraw treść</Link>{!contentApproved && <button type="button" className="admin-button" disabled={frozen || active || Boolean(instructions) || !bothContentLanguagesSeen || contentConfirmation !== record.revision || Boolean(presentationIssue) || staleHeroDraft} onClick={() => void perform('approve_content', heroPresentation ? { heroPresentation } : {})}><Check size={18} />Akceptuję treść <ArrowRight size={16} /></button>}</> : <button type="button" className="admin-button" disabled={frozen || active || !canStartText || Boolean(instructions)} onClick={() => void perform('generate_text')}><Sparkles size={18} />{busy === 'generate_text' ? 'Rozpoczynam…' : 'Wygeneruj przepis'}</button>}{hasText && canStartText && textJob?.status === 'failed' && <button type="button" className="admin-button" disabled={frozen || active || Boolean(instructions)} onClick={() => void perform('generate_text')}><Sparkles size={18} />{busy === 'generate_text' ? 'Rozpoczynam…' : 'Wygeneruj poprawiony przepis'}</button>}{textJob?.status === 'ready' && <button type="button" className="admin-button is-secondary" disabled={frozen || active || textJob.baseRevision !== record.revision} onClick={() => void perform('apply_text', { jobId: textJob.id })}>Wczytaj gotową treść</button>}</div>
      </section>
      <section className={`guided-stage ${currentStage === 1 ? 'is-current' : ''}`} aria-labelledby="guided-photos-heading">
        <div className="guided-stage-heading"><span className="guided-stage-number">02</span><div><h2 id="guided-photos-heading">Wygeneruj brakujące grafiki</h2><p>Najpierw składniki z biblioteki lub nowe zdjęcia, potem kroki, a na końcu gotowa potrawa.</p></div>{allPhotos && !generatingPhotos && <span className="guided-approved"><CheckCircle2 size={17} />Grafiki gotowe</span>}</div>
        {!contentApproved && <p className="guided-stage-hint">Najpierw przeczytaj i zaakceptuj treść przepisu.</p>}
        {generatingPhotos && <div className="guided-working" role="status"><LoaderCircle size={21} className="admin-spinner" /><div><strong>Przygotowujemy grafiki · {photoBatch?.progress.completed ?? 0} z {photoBatch?.progress.total ?? 0}</strong><p>Zgodne zdjęcia składników pobieramy z biblioteki. Postęp odświeża się automatycznie.</p>{photoBatch && <progress value={photoBatch.progress.completed} max={Math.max(1, photoBatch.progress.total)} aria-label="Postęp przygotowania grafik" />}</div></div>}
        {photosNeedAttention && <div className="admin-notice" role="status"><AlertCircle size={18} /><div><p>{safeError(photoBatch?.errorMessage || 'Część grafik wymaga uwagi. Gotowe zdjęcia są zachowane.')}</p><Link className="admin-text-link" href={`/admin/ai?recipe=${encodeURIComponent(record.id)}`}>Sprawdź szczegóły grafik <ArrowRight size={15} /></Link></div></div>}
        {photoBatch?.status === 'ready' && photoBatch.baseRevision !== record.revision && !photoBatchCompatible && <div className="admin-notice" role="status"><AlertCircle size={18} /><div><p>Gotowe grafiki powstały dla wcześniejszej wersji. Sprawdź je przed przypisaniem do zmienionego przepisu.</p><Link className="admin-text-link" href={`/admin/ai?recipe=${encodeURIComponent(record.id)}`}>Porównaj gotowe grafiki <ArrowRight size={15} /></Link></div></div>}
        {hasText && !allPhotos && !generatingPhotos && <p className="guided-stage-hint">Do uzupełnienia: {missingIngredients} zdjęć składników, {missingSteps} zdjęć kroków{!recipe.image ? ' i zdjęcie główne' : ''}.</p>}
        {hasText && <RecipePhotoEditor record={record} contentApproved={contentApproved} disabled={Boolean(busy) || !loaded || conflict || readonly || Boolean(pending) || Boolean(correction) || Boolean(instructions) || active || heroDirty} onReload={reloadPhotoContext} onLockChange={setPhotoEditorLock} />}
        {(allPhotos || photoBatch) && <div className="guided-photo-strip" aria-label="Podgląd zdjęć przepisu">{recipe.ingredients.filter(item => record.content.photos.ingredients[item.id]).map(item => <figure key={item.id}><RecipePhoto media={record.content.photos.ingredients[item.id]} locale="pl" sizes="100px" legacySizes="320px" maximumWidth={160} /><figcaption>{item.name.pl}<Link className="admin-text-link" href={`/admin/library?recipeId=${encodeURIComponent(record.id)}&kind=ingredient&targetId=${encodeURIComponent(item.id)}`}>Wybierz zdjęcie</Link></figcaption></figure>)}{recipe.steps.filter(item => record.content.photos.steps[item.id]).map(item => <figure key={item.id}><RecipePhoto media={record.content.photos.steps[item.id]} locale="pl" sizes="120px" maximumWidth={320} /><figcaption>{item.title.pl}<Link className="admin-text-link" href={`/admin/library?recipeId=${encodeURIComponent(record.id)}&kind=step&targetId=${encodeURIComponent(item.id)}`}>Wybierz zdjęcie</Link></figcaption></figure>)}{photoBatch?.slots.filter(slot => slot.status === 'ready' && slot.job?.result?.asset).map(slot => <figure key={`${slot.kind}:${slot.targetId}`}><MediaImage src={slot.job!.result!.asset!.src} alt={slot.label} width={120} height={100} maximumWidth={160} sizes="100px" /><figcaption>{slot.label}</figcaption></figure>)}{recipe.image && <figure className="is-hero"><MediaImage src={recipe.image} alt={recipe.imageAlt.pl || recipe.title.pl} width={160} height={120} maximumWidth={320} sizes="160px" /><figcaption>Gotowa potrawa<Link className="admin-text-link" href={`/admin/library?recipeId=${encodeURIComponent(record.id)}&kind=hero`}>Wybierz zdjęcie</Link></figcaption></figure>}</div>}
        <details className="guided-sources"><summary>Wybierz zapisane zdjęcie dla konkretnego miejsca</summary><ul><li><Link href={`/admin/library?recipeId=${encodeURIComponent(record.id)}&kind=hero`}>Gotowa potrawa</Link></li>{recipe.ingredients.map(item => <li key={item.id}><Link href={`/admin/library?recipeId=${encodeURIComponent(record.id)}&kind=ingredient&targetId=${encodeURIComponent(item.id)}`}>Składnik: {item.name.pl}</Link></li>)}{recipe.steps.map((item, index) => <li key={item.id}><Link href={`/admin/library?recipeId=${encodeURIComponent(record.id)}&kind=step&targetId=${encodeURIComponent(item.id)}`}>Krok {index + 1}: {item.title.pl}</Link></li>)}</ul></details>
        <div className="guided-stage-actions"><Link className="admin-button is-secondary" href={`/admin/library?recipeId=${encodeURIComponent(record.id)}`}>Wybierz zdjęcia z biblioteki</Link>{!allPhotos && <button type="button" className="admin-button" disabled={frozen || !contentApproved || active || Boolean(instructions)} onClick={() => void perform('generate_photos')}><ImagePlus size={18} />{photosNeedAttention ? 'Kontynuuj generowanie grafik' : 'Wygeneruj brakujące grafiki'}</button>}{photoBatch?.status === 'ready' && <button type="button" className="admin-button is-secondary" disabled={frozen || active || photoBatch.baseRevision !== record.revision && !photoBatchCompatible} onClick={() => void perform('apply_photos', { batchId: photoBatch.id })}>Wczytaj gotowe grafiki</button>}</div>
      </section>
      <section className={`guided-stage ${currentStage === 2 ? 'is-current' : ''}`} aria-labelledby="guided-publish-heading">
        <div className="guided-stage-heading"><span className="guided-stage-number">03</span><div><h2 id="guided-publish-heading">Sprawdź podgląd i opublikuj</h2><p>Zobacz dokładnie taki przepis, jaki otrzyma użytkownik.</p></div></div>
        {showPreview ? <><div className="guided-preview-toolbar"><span><Eye size={17} />Podgląd przepisu · wersja {record.revision}</span><div className="admin-locale-tabs" aria-label="Język podglądu"><button type="button" aria-pressed={previewLocale === 'pl'} onClick={() => setPreviewLocale('pl')}>{plPreviewSeen && <Check size={15} aria-hidden="true" />}Polski</button><button type="button" aria-pressed={previewLocale === 'en'} onClick={() => setPreviewLocale('en')}>{enPreviewSeen && <Check size={15} aria-hidden="true" />}English</button></div><a className="admin-text-link" href={recipePreviewUrl(record.id, record.revision, previewLocale, currentPreviewScope?.token)} target="_blank" rel="noopener noreferrer">Otwórz pełny podgląd <ArrowRight size={15} /></a></div><p className="guided-stage-hint" role="status" aria-live="polite">PL: {plPreviewSeen ? 'wczytany' : 'do wczytania'} · EN: {enPreviewSeen ? 'wczytany' : 'do wczytania'}. Wczytaj oba języki tutaj lub w pełnym podglądzie, a następnie potwierdź swój przegląd poniżej.</p><RecipePreviewFrame recipeId={record.id} revision={record.revision} locale={previewLocale} reviewToken={currentPreviewScope?.token} onReady={previewReady} onLocaleChange={setPreviewLocale} /></> : <p className="guided-stage-hint">Podgląd będzie dostępny po zaakceptowaniu treści i przygotowaniu wszystkich grafik.</p>}
        {showPreview && record.issues.length > 0 && <details className="guided-sources"><summary>Do sprawdzenia przed publikacją ({record.issues.length})</summary><ul>{record.issues.map((issue, index) => <li key={`${issue.field}:${index}`}>{issue.message}</li>)}</ul></details>}
        {!publishedCurrent && <p id="guided-publication-status" className="guided-stage-hint" role="status" aria-live="polite">{publishBlockReason}</p>}
        {showPreview && !publishedCurrent && <fieldset disabled={frozen || active || !bothPreviewLanguagesSeen} aria-describedby="guided-publication-status" style={{ border: 0, padding: 0 }}><legend>Potwierdź przegląd bieżącej wersji przed publikacją</legend><label className="admin-checkbox"><input type="checkbox" checked={allChecks} onChange={event => { const confirmed = event.target.checked; setReview({ revision: record.revision, checks: { pl: confirmed, en: confirmed, quantities: confirmed, method: confirmed, photos: confirmed, sources: confirmed } }); }} /><span>Sprawdziłem obie wersje językowe, składniki i ilości, kroki i czasy, fotografie, pochodzenie oraz zamienniki.</span></label></fieldset>}
        <div className="guided-stage-actions">{publishedCurrent ? <div className="guided-published" role="status"><CheckCircle2 size={20} /><strong>Przepis jest opublikowany.</strong><a className="admin-text-link" href={`/pl/recipes/${encodeURIComponent(recipe.slug.pl)}`} target="_blank" rel="noopener noreferrer">Zobacz w serwisie <ArrowRight size={15} /></a></div> : <button type="button" className="admin-button" disabled={frozen || active || Boolean(instructions) || !showPreview || record.issues.length > 0 || !allChecks} onClick={() => void perform('publish')}><CheckCircle2 size={18} />{busy === 'publish' ? 'Publikuję…' : record.publicationStatus === 'published' ? 'Opublikuj zmiany' : 'Publikuj przepis'}</button>}</div>
      </section>
    </>}
  </div>;
}
