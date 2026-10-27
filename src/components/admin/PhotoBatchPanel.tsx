'use client';

import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import { MediaImage } from '@/components/MediaImage';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock3, ImagePlus, LoaderCircle, PauseCircle, RefreshCw, Sparkles } from 'lucide-react';
import { RecipePhoto } from '@/components/RecipePhoto';
import { ReviewedIngredientRetakeButton } from '@/components/admin/ReviewedIngredientRetakeButton';
import type { AiConfiguration } from '@/lib/ai-types';
import type { AiPhotoBatch, AiPhotoBatchSlot, AiPhotoBatchStatus, CreateAiPhotoBatch } from '@/lib/ai-photo-batch-types';
import type { EditorialContent, EditorialRecord } from '@/lib/editorial-types';
import type { PhotoBatchBilling } from '@/lib/photo-batch-billing-types';
import { photoBatchPollInterval, shouldShowPhotoBatchStart } from '@/lib/photo-batch-presentation';

const batchLabels: Record<AiPhotoBatchStatus, string> = { queued: 'Pakiet w kolejce', generating: 'Przygotowujemy zdjęcia', ready: 'Zdjęcia do sprawdzenia', blocked: 'Pakiet wymaga uwagi', failed: 'Pakiet wymaga uwagi', applied: 'Zdjęcia zapisane w szkicu' };
const slotLabels: Record<AiPhotoBatchSlot['status'], string> = { pending: 'Czeka na swoją kolej', queued: 'W kolejce', submitting: 'Rozpoczynanie', generating: 'Generowanie', ready: 'Do sprawdzenia', failed: 'Wymaga uwagi', uncertain: 'Wymaga sprawdzenia', cancelled: 'Anulowane', applied: 'W szkicu' };
const kinds = { hero: 'Zdjęcie główne', ingredient: 'Składnik', step: 'Etap przygotowania' };
const isRunning = (batch: AiPhotoBatch | null) => batch?.status === 'queued' || batch?.status === 'generating';
const usd = (value: string | number) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value));
const studioMessage = (value: string) => value.replace(/OpenAI(?: API)?/g, 'generator treści').replace(/fal\.ai/g, 'generator zdjęć').replace(/\bAI\b/g, 'generowania');
const errorText = (error: unknown) => error instanceof TypeError ? 'Brak połączenia z serwisem. Odśwież stan pakietu.' : error instanceof Error ? studioMessage(error.message) : 'Nie udało się połączyć z serwisem.';
const updatedTime = (value: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const capacityCodes = ['AI_STORAGE_CAPACITY', 'AI_RESULT_STORAGE_CAPACITY'];
const unavailableCodes = ['AI_STORAGE_UNAVAILABLE', 'AI_RESULT_STORAGE_UNAVAILABLE'];

type PendingRequest = { version: 1; input: CreateAiPhotoBatch; prepared: boolean };
type Props = {
  record: EditorialRecord;
  previewContent?: EditorialContent;
  sourceJobId?: string;
  saveDraftFirst?: boolean;
  canStart?: boolean;
  disabled?: boolean;
  configuration?: AiConfiguration;
  beforeStart?: (mode: NonNullable<CreateAiPhotoBatch['mode']>) => Promise<EditorialRecord>;
  onRecipeUpdated: (recipe: EditorialRecord) => void;
  onBusyChange: (busy: boolean) => void;
};

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się wczytać pakietu zdjęć.');
  return body;
}

function PhotoSlot({ slot, batchRunning, children }: { slot: AiPhotoBatchSlot; batchRunning: boolean; children?: React.ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const result = slot.job?.result;
  const asset = result?.asset;
  const photo = result?.reusedPhoto;
  const reused = Boolean(photo);
  const src = photo?.src ?? asset?.src;
  const imageFailed = Boolean(src && failedSrc === src);
  const working = batchRunning && Boolean(slot.job) && (slot.status === 'submitting' || slot.status === 'generating');
  const waiting = slot.status === 'pending' || slot.status === 'queued' || slot.status === 'submitting' || slot.status === 'generating';
  const paused = waiting && !batchRunning;
  const label = imageFailed ? 'Nie udało się wczytać zdjęcia' : paused ? 'Oczekuje na wznowienie pakietu' : waiting && !working ? 'Czeka na swoją kolej' : slotLabels[slot.status];
  const imageKey = (src ?? '') + ':' + reloadAttempt;
  const paper = slot.kind === 'ingredient' && (asset?.styleProfile ?? photo?.styleProfile) === 'jesie-ingredient-paper-studio-v3';
  return <figure className={'admin-photo-batch-slot is-' + slot.kind + (paper ? ' is-paper' : '')}>
    <div className="admin-photo-batch-image" onErrorCapture={() => { if (src) setFailedSrc(src); }} onLoadCapture={() => setFailedSrc(null)}>
      {imageFailed ? <span className="admin-photo-batch-placeholder" role="status"><AlertCircle size={28} /><span>Podgląd zdjęcia jest niedostępny</span></span> : photo ? <RecipePhoto key={imageKey} media={photo} locale="pl" sizes="150px" legacySizes="(max-width: 600px) 100vw, 33vw" maximumWidth={320} /> : asset ? <MediaImage key={imageKey} src={asset.src} alt={asset.alt.pl.replace(/^(?:Ilustracja AI|AI illustration):\s*/i, '')} width={asset.width} height={asset.height} sizes="(max-width: 600px) calc(100vw - 80px), (max-width: 1180px) calc((100vw - 320px) / 3), 320px" maximumWidth={640} /> : <span className="admin-photo-batch-placeholder">{working ? <LoaderCircle size={25} className="admin-spinner" /> : paused ? <PauseCircle size={28} /> : waiting ? <Clock3 size={28} /> : <ImagePlus size={28} />}<span>{label}</span></span>}
    </div>
    <figcaption><span className="admin-photo-batch-kind">{kinds[slot.kind]}</span><strong>{slot.label}</strong><span className={'admin-photo-batch-slot-status is-' + (imageFailed ? 'failed' : slot.status)}>{imageFailed ? label : reused ? result?.reuse?.source === 'shared_generation' ? 'Wspólne zdjęcie składnika' : 'Z biblioteki · bez nowego zdjęcia' : label}</span>
      {imageFailed && <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => { setFailedSrc(null); setReloadAttempt(value => value + 1); }}><RefreshCw size={13} />Wczytaj plik ponownie</button>}
      {asset && !imageFailed && <a className="admin-text-link" href={asset.src} target="_blank" rel="noopener noreferrer">Pełny kadr<ArrowUpRight size={13} /></a>}
      {slot.job?.errorMessage && <p className="admin-photo-batch-slot-error">{studioMessage(slot.job.errorMessage)}</p>}
      {slot.job && (imageFailed || paused || slot.status === 'failed' || slot.status === 'uncertain') && <Link className="admin-text-link" href={'/admin/ai/' + encodeURIComponent(slot.job.id)}>Sprawdź to zdjęcie<ArrowUpRight size={13} /></Link>}
      {children}
    </figcaption>
  </figure>;
}

export function PhotoBatchPanel({ record, previewContent, sourceJobId, saveDraftFirst = false, canStart = true, disabled = false, beforeStart, onRecipeUpdated, onBusyChange }: Props) {
  const [batch, setBatch] = useState<AiPhotoBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'start' | 'resume' | 'apply' | 'refresh' | 'billing' | null>(null);
  const [billing, setBilling] = useState<PhotoBatchBilling | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [notice, setNotice] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [pendingMode, setPendingMode] = useState<NonNullable<CreateAiPhotoBatch['mode']> | null>(null);
  const [conflict, setConflict] = useState(false);
  const busyRef = useRef(false);
  const pendingRequest = useRef<PendingRequest | null>(null);
  const storageKey = 'jesie:photo-batch-pending:v1:' + record.id + ':' + (sourceJobId || 'draft');
  const listUrl = '/api/admin/ai/photo-batches?recipeId=' + encodeURIComponent(record.id) + (sourceJobId ? '&sourceJobId=' + encodeURIComponent(sourceJobId) : '');
  const content = saveDraftFirst ? previewContent ?? record.content : record.content;
  const missing = {
    hero: content.recipe.image.trim() ? 0 : 1,
    ingredients: content.recipe.ingredients.filter(item => !content.photos.ingredients[item.id]?.src).length,
    steps: content.recipe.steps.filter(item => isStepPhotoRequired(content, item.id) && !content.photos.steps[item.id]?.src).length,
  };
  const missingTotal = missing.hero + missing.ingredients + missing.steps;
  const ingredientCount = content.recipe.ingredients.length;
  const whiteBatch = batch?.mode === 'ingredients-white';
  const paperBatch = batch?.mode === 'ingredients-paper';
  const ingredientBatch = whiteBatch || paperBatch;
  const running = isRunning(batch);
  const unfinishedSlots = batch?.slots.filter(slot => slot.status === 'pending' || slot.status === 'queued' || slot.status === 'submitting' || slot.status === 'generating' || slot.status === 'uncertain') ?? [];
  const activeCount = batch?.slots.filter(slot => Boolean(slot.job) && (slot.status === 'submitting' || slot.status === 'generating')).length ?? 0;
  const readyCount = batch?.slots.filter(slot => (slot.status === 'ready' || slot.status === 'applied') && Boolean(slot.job?.result?.asset || slot.job?.result?.reusedPhoto)).length ?? 0;
  const failedCount = batch?.progress.failed ?? batch?.slots.filter(slot => slot.status === 'failed' || slot.status === 'cancelled').length ?? 0;
  const canResume = batch ? batch.canResume ?? (batch.status === 'blocked' || batch.status === 'failed' && unfinishedSlots.length > 0) : false;
  const canApply = batch ? batch.canApply ?? (batch.status === 'ready' || batch.status === 'failed' && batch.errorCode === 'PHOTO_BATCH_PARTIAL' && unfinishedSlots.length === 0 && readyCount > 0) : false;
  const partial = batch?.status === 'failed' && batch.errorCode === 'PHOTO_BATCH_PARTIAL';
  const showStart = shouldShowPhotoBatchStart(batch, { saveDraftFirst, unconfirmed, missingTotal, canResume, canApply });
  const pollInterval = photoBatchPollInterval(batch);
  const storageError = capacityCodes.includes(batch?.errorCode ?? '') || batch?.slots.some(slot => capacityCodes.includes(slot.job?.errorCode ?? '')) ? 'capacity'
    : unavailableCodes.includes(batch?.errorCode ?? '') || batch?.slots.some(slot => unavailableCodes.includes(slot.job?.errorCode ?? '')) ? 'unavailable' : null;
  const unknownAcceptance = batch?.slots.some(slot => slot.status === 'uncertain' && slot.job && !slot.job.providerRequestId && !slot.job.reuseSourceJobId);
  const whiteView = whiteBatch && !showStart || pendingMode === 'ingredients-white';
  const paperView = paperBatch && !showStart || pendingMode === 'ingredients-paper';
  const statusLabel = partial ? 'Gotowe zdjęcia i wyniki wymagające uwagi' : batch?.status === 'applied' && failedCount > 0 ? 'Gotowe zdjęcia zapisane w szkicu' : batch ? batchLabels[batch.status] : '';
  const reuseCount = batch?.slots.filter(slot => slot.job?.result?.reusedPhoto).length ?? 0;
  const frozen = busy !== null || disabled;
  const canGenerate = canStart && record.editorialStatus !== 'archived' && missingTotal > 0 && !conflict;
  const ingredientWorkUnresolved = Boolean(batch?.slots.some(slot => slot.kind === 'ingredient' && (slot.status === 'queued' || slot.status === 'submitting' || slot.status === 'generating' || slot.status === 'uncertain')));
  const canReplaceIngredients = canStart && !saveDraftFirst && record.editorialStatus !== 'archived' && ingredientCount > 0 && !conflict && !running && !ingredientWorkUnresolved && batch?.status !== 'blocked' && !unconfirmed;

  const savePending = useCallback((request: PendingRequest | null) => {
    pendingRequest.current = request;
    setPendingMode(request ? request.input.mode ?? 'missing' : null);
    try { if (request) sessionStorage.setItem(storageKey, JSON.stringify(request)); else sessionStorage.removeItem(storageKey); } catch { /* The in-memory key still protects retries if browser storage is unavailable. */ }
  }, [storageKey]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const data = await read<{ batches: AiPhotoBatch[] }>(listUrl, signal);
    if (signal?.aborted) return;
    const batches = data.batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setBatch(batches[0] ?? null);
  }, [listUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored) {
          const request = JSON.parse(stored) as PendingRequest;
          if (request.version === 1 && request.input?.recipeId === record.id && request.input.sourceJobId === sourceJobId && (request.input.mode === undefined || request.input.mode === 'missing' || request.input.mode === 'ingredients-white' || request.input.mode === 'ingredients-paper') && typeof request.input.requestKey === 'string' && Number.isInteger(request.input.expectedRevision) && typeof request.prepared === 'boolean') { pendingRequest.current = request; setPendingMode(request.input.mode ?? 'missing'); setUnconfirmed(true); }
        }
      } catch { /* Invalid or unavailable browser storage does not stop loading the saved batch. */ }
      await load(controller.signal);
    }).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, record.id, sourceJobId, storageKey]);

  const batchId = batch?.id;
  useEffect(() => {
    if (!pollInterval || !batchId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let disposed = false;
    let generation = 0;
    let delay = pollInterval;
    const schedule = () => { if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), delay); };
    const poll = async () => {
      const request = ++generation;
      const currentController = new AbortController();
      controller = currentController;
      try {
        const data = await read<{ batch: AiPhotoBatch }>('/api/admin/ai/photo-batches/' + encodeURIComponent(batchId), currentController.signal);
        if (disposed || request !== generation || busyRef.current) return;
        setBatch(data.batch); setPollError(''); delay = pollInterval;
      } catch (err) {
        if (!disposed && request === generation && !currentController.signal.aborted && !busyRef.current) { delay = Math.min(delay * 2, 60000); setPollError(errorText(err)); }
      } finally { if (request === generation) schedule(); }
    };
    const visibility = () => { ++generation; clearTimeout(timer); controller?.abort(); if (!document.hidden) void poll(); };
    schedule(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [batchId, pollInterval]);

  const begin = async (mode: NonNullable<CreateAiPhotoBatch['mode']> = 'missing') => {
    if (busyRef.current || disabled || (!pendingRequest.current && !(mode !== 'missing' ? canReplaceIngredients : canGenerate))) return;
    busyRef.current = true; setBusy('start'); onBusyChange(true); setError(''); setNotice('');
    if (!pendingRequest.current) savePending({ version: 1, input: { recipeId: record.id, expectedRevision: record.revision, requestKey: crypto.randomUUID(), mode, ...(sourceJobId ? { sourceJobId } : {}) }, prepared: false });
    try {
      if (!pendingRequest.current!.prepared) {
        const mode = pendingRequest.current!.input.mode ?? 'missing';
        const recipe = beforeStart ? await beforeStart(mode) : record;
        savePending({ ...pendingRequest.current!, input: { ...pendingRequest.current!.input, expectedRevision: recipe.revision }, prepared: true });
      }
      const response = await fetch('/api/admin/ai/photo-batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingRequest.current!.input) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500 || body.code === 'PROVIDER_NOT_CONFIGURED') { savePending(null); setUnconfirmed(false); }
        if (response.status === 409) setConflict(true);
        throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się rozpocząć pakietu zdjęć.');
      }
      if (!body.batch?.id) throw new Error('Nie otrzymaliśmy potwierdzenia pakietu. Sprawdź to samo zgłoszenie ponownie.');
      setBatch(body.batch); setPollError(''); savePending(null); setUnconfirmed(false); setConflict(false);
    } catch (err) {
      if (pendingRequest.current) setUnconfirmed(true);
      setError(errorText(err));
    } finally { busyRef.current = false; setBusy(null); onBusyChange(false); }
  };

  const action = async (name: 'resume' | 'apply') => {
    if (!batch || busyRef.current || disabled) return;
    busyRef.current = true; setBusy(name); onBusyChange(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/ai/photo-batches/' + encodeURIComponent(batch.id) + '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, ...(name === 'apply' ? { expectedRevision: record.revision } : {}) }) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); if (body.latest) onRecipeUpdated(body.latest); }
        throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się wykonać tej operacji.');
      }
      if (!body.batch?.id || name === 'apply' && !body.recipe) throw new Error('Nie otrzymaliśmy potwierdzenia. Odśwież stan pakietu przed następną operacją.');
      setBatch(body.batch); setPollError(''); setConflict(false);
      if (name === 'resume') setNotice('Sprawdzono zapisany pakiet. Gotowe zdjęcia i istniejące zlecenia zostały zachowane.');
      if (body.recipe) onRecipeUpdated(body.recipe);
    } catch (err) { setError(errorText(err)); }
    finally { busyRef.current = false; setBusy(null); onBusyChange(false); }
  };

  const refresh = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy('refresh'); onBusyChange(true); setError('');
    try {
      const [, data] = await Promise.all([load(), read<{ recipe: EditorialRecord }>('/api/admin/recipes/' + encodeURIComponent(record.id))]);
      onRecipeUpdated(data.recipe); setPollError(''); setConflict(false);
    } catch (err) { setError(errorText(err)); }
    finally { busyRef.current = false; setBusy(null); onBusyChange(false); }
  };

  const checkBilling = async () => {
    if (!batch || busyRef.current || disabled) return;
    busyRef.current = true; setBusy('billing'); onBusyChange(true); setError('');
    try {
      const response = await fetch('/api/admin/ai/photo-batches/' + encodeURIComponent(batch.id) + '/billing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reconcile' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się sprawdzić rozliczenia.');
      if (body.billing?.batchId !== batch.id) throw new Error('Nie otrzymaliśmy potwierdzenia rozliczenia tego pakietu.');
      setBilling(body.billing);
    } catch (err) { setError(errorText(err)); }
    finally { busyRef.current = false; setBusy(null); onBusyChange(false); }
  };

  return <section className="admin-photo-batch" aria-label="Komplet zdjęć przepisu">
    <div className="admin-photo-batch-heading"><div><p className="admin-eyebrow">KOMPLET ZDJĘĆ</p><h2>{paperView ? 'Składniki na tle serwisu.' : whiteView ? 'Składniki na białym tle.' : 'Wszystkie brakujące kadry.'}</h2></div><ImagePlus size={28} strokeWidth={1.4} aria-hidden="true" /></div>
    <p>{paperView ? 'Przygotujemy studyjne fotografie konkretnych składników na jednolitym tle w dokładnym kolorze jesie.pl, z miękkim naturalnym cieniem. Przejrzysz je przed zastąpieniem zdjęć w szkicu. Zachowamy zapisane zdjęcie główne i etapy; gotowe kadry z wcześniejszego pakietu uzupełnią brakujące miejsca.' : whiteView ? 'Przygotujemy studyjne fotografie konkretnych składników na czystym białym tle, z miękkim naturalnym cieniem. Przejrzysz je przed zastąpieniem zdjęć w szkicu. Zachowamy zapisane zdjęcie główne i etapy; gotowe kadry z wcześniejszego pakietu uzupełnią brakujące miejsca.' : 'Przygotujemy zdjęcie główne, zdjęcia składników i każdego etapu na podstawie treści szkicu. Zachowamy istniejące zdjęcia. Składniki sfotografujemy na tle w kolorze serwisu, z miękkim naturalnym cieniem; zgodne fotografie wykorzystamy z biblioteki.'}</p>
    {showStart && pendingMode !== 'ingredients-white' && pendingMode !== 'ingredients-paper' && <div className="admin-photo-batch-summary"><span><strong>{missing.hero}</strong> główne</span><span><strong>{missing.ingredients}</strong> składników</span><span><strong>{missing.steps}</strong> etapów</span></div>}
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={17} /><div><p>{error}</p>{unconfirmed && <p>Zgłoszenie mogło zostać zapisane. Przycisk sprawdzi ten sam identyfikator pakietu.</p>}{conflict && <p>Wczytaj aktualny szkic i sprawdź treść przed kontynuowaniem.</p>}</div></div>}
    {pollError && <div className="admin-notice is-error" role="alert"><AlertCircle size={17} /><p>{pollError}</p></div>}
    {notice && <div className="admin-notice is-success" role="status"><CheckCircle2 size={17} /><p>{notice}</p></div>}
    {loading ? <p className="admin-photo-batch-loading" role="status"><LoaderCircle size={16} className="admin-spinner" />Sprawdzamy zapisane pakiety…</p> : batch ? <>
      <div className="admin-photo-batch-progress" aria-live="polite"><div>{running ? <LoaderCircle size={18} className="admin-spinner" /> : batch.status === 'blocked' || batch.status === 'failed' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}<strong>{statusLabel}</strong><span>{batch.progress.completed} / {batch.progress.total}</span></div><progress max={Math.max(1, batch.progress.total)} value={batch.progress.completed} aria-label={'Gotowe zdjęcia: ' + batch.progress.completed + ' z ' + batch.progress.total} /><p>{running ? 'W przygotowaniu: ' + activeCount + '. W kolejce: ' + Math.max(0, unfinishedSlots.length - activeCount) + '. Możesz zamknąć tę stronę; pakiet i postęp pozostaną zapisane w studio.' : batch.status === 'ready' ? ingredientBatch ? 'Sprawdź zdjęcia składników oraz gotowe kadry dania i etapów. Wszystkie zdjęcia zapiszesz razem w szkicu.' : 'Sprawdź potrawę, składniki i kolejne etapy. Cały komplet zapiszesz do szkicu jednym przyciskiem.' : batch.status === 'applied' ? 'Gotowe zdjęcia trafiły do wersji ' + batch.appliedRevision + ' szkicu.' : partial ? 'Przejrzyj gotowe kadry i zapisz je razem w szkicu. Każde zdjęcie z błędem pozostaje opisane osobno.' : canResume ? 'Gotowe kadry pozostają w podglądzie. Kontynuowanie sprawdzi zapisane zlecenia i stan pozostałych zdjęć.' : 'Gotowe kadry pozostają w podglądzie. Pozostałe wyniki wymagają sprawdzenia.'}{failedCount > 0 && ' Zdjęcia wymagające uwagi: ' + failedCount + '.'}{reuseCount > 0 && ' Wykorzystane istniejące zdjęcia składników: ' + reuseCount + '.'}</p></div>
      {batch.errorMessage && <div className={'admin-notice' + (batch.status === 'blocked' || batch.status === 'failed' ? ' is-error' : '')} role={batch.status === 'blocked' || batch.status === 'failed' ? 'alert' : 'status'}><AlertCircle size={17} /><div>{(batch.status === 'blocked' || batch.status === 'failed') && <strong>{partial ? 'Nie wszystkie zdjęcia udało się przygotować.' : 'Przygotowanie pakietu zostało zatrzymane.'}</strong>}<p>{studioMessage(batch.errorMessage)}</p></div></div>}
      <p className="admin-photo-batch-footnote">Ostatni zapis postępu: <time dateTime={batch.updatedAt}>{updatedTime(batch.updatedAt)}</time>.{pollInterval === 15000 && ' Odświeżamy stan istniejących zleceń, gdy ta strona jest widoczna.'}</p>
      {canResume && <div className="admin-notice" role="status"><RefreshCw size={17} /><div><strong>{running ? 'Postęp się zatrzymał?' : 'Możesz wrócić do tego samego pakietu.'}</strong><p>{storageError === 'capacity' ? 'Brakuje miejsca na zapis nowych zdjęć. Po zwolnieniu miejsca kontynuuj ten pakiet, aby zachować jego wyniki.' : storageError === 'unavailable' ? 'Magazyn zdjęć jest niedostępny. Po przywróceniu dostępu kontynuuj ten pakiet; zachowane zlecenia pozwolą ponowić odczyt wyników.' : unknownAcceptance ? 'Dla jednego ze zdjęć brakuje potwierdzenia przyjęcia. Sprawdzimy zapisany pakiet; ponowne zlecenie tego zdjęcia pozostanie zablokowane do wyjaśnienia.' : running ? 'Przycisk „Sprawdź i wznów” sprawdzi trwające przygotowanie i przywróci je, jeśli zostało przerwane. Gotowe kadry oraz zapisane zlecenia pozostaną w tym pakiecie.' : 'Przycisk „Kontynuuj pakiet” zachowa gotowe kadry i sprawdzi zapisane zlecenia. Pozostałe zdjęcia będą przygotowywane w tym samym pakiecie.'}</p></div></div>}
      {batch.slots.length > 0 ? <div className="admin-photo-batch-gallery">{batch.slots.map(slot => <PhotoSlot key={slot.kind + ':' + (slot.targetId || 'hero')} slot={slot} batchRunning={running}>
        {batch.status === 'ready' && batch.appliedRevision === null && slot.kind === 'ingredient' && slot.targetId === 'white_wine' && slot.job?.status === 'ready' && <ReviewedIngredientRetakeButton key={slot.job.id} batch={batch} jobId={slot.job.id} expectedRevision={record.revision} disabled={frozen || conflict || record.editorialStatus === 'archived'} onBatchUpdated={updated => { setBatch(updated); setBilling(null); }} onBusyChange={working => { busyRef.current = working; setBusy(working ? 'start' : null); onBusyChange(working); }} />}
      </PhotoSlot>)}</div> : <p className="admin-photo-batch-complete"><CheckCircle2 size={18} />Zdjęcia są kompletne.</p>}
    </> : null}
    {billing && billing.batchId === batch?.id && <div className="admin-notice" role="status"><div><strong>Rozliczenie pakietu</strong><p>{billing.pendingJobs > 0 && Number(billing.verifiedCostUsd) === 0 ? 'Koszt oczekuje na potwierdzenie przez dostawcę.' : <>Potwierdzone koszty: {usd(billing.verifiedCostUsd)}.</>}{billing.pendingJobs > 0 && ' Zlecenia oczekujące na rozliczenie: ' + billing.pendingJobs + '.'}</p><p>{billing.read.status === 'forbidden' ? 'Usługa zdjęć nie udostępniła rachunków. Potrzebny jest klucz z dostępem do rozliczeń.' : billing.read.status === 'unauthenticated' ? 'Usługa zdjęć nie zaakceptowała dostępu do rachunków. Sprawdź podłączenie rozliczeń w ustawieniach serwera.' : billing.read.status === 'not_configured' ? 'Dostęp do rachunków usługi zdjęć nie jest skonfigurowany.' : billing.read.status === 'invalid' ? 'Dostawca zwrócił niepełne lub nieprawidłowe rozliczenie. Sprawdź je ponownie później.' : billing.read.status === 'unavailable' ? 'Rachunki są chwilowo niedostępne. Możesz sprawdzić je później.' : billing.pendingJobs > 0 ? 'Niepotwierdzone kwoty pozostają nieznane do czasu odczytu rachunku dostawcy.' : 'Koszty zakończonych zdjęć zostały potwierdzone.'}{billing.read.httpStatus !== null && billing.read.httpStatus !== 200 && ' Kod odpowiedzi: ' + billing.read.httpStatus + '.'}{billing.reconciledJobs > 0 && ' Zaktualizowane rozliczenia: ' + billing.reconciledJobs + '.'}</p><p>Sprawdzenie rachunków nie uruchamia nowych zdjęć.</p></div></div>}
    {!loading && <div className="admin-photo-batch-footer"><div><p>{batch && !showStart ? 'Potwierdzone koszty zobaczysz po sprawdzeniu rozliczenia pakietu.' : 'Wykorzystanie biblioteki obniży koszt. Gotowe zdjęcia sprawdzisz przed zapisaniem w szkicu.'}</p></div><div className="admin-photo-batch-actions">
      {!showStart && canApply && canResume && <button type="button" className="admin-button is-secondary" onClick={() => void action('resume')} disabled={frozen || conflict || record.editorialStatus === 'archived'}>{busy === 'resume' ? <LoaderCircle size={17} className="admin-spinner" /> : <RefreshCw size={17} />}Kontynuuj pakiet</button>}
      {showStart ? <button type="button" className="admin-button" onClick={() => void begin()} disabled={frozen || (!unconfirmed && !canGenerate)}>{busy === 'start' ? <LoaderCircle size={17} className="admin-spinner" /> : missingTotal === 0 && !unconfirmed ? <CheckCircle2 size={17} /> : <Sparkles size={17} />}{unconfirmed ? 'Sprawdź zgłoszenie pakietu' : missingTotal === 0 ? 'Zdjęcia są kompletne' : saveDraftFirst ? 'Zapisz szkic i generuj zdjęcia' : batch?.status === 'failed' ? 'Generuj pozostałe zdjęcia' : 'Generuj brakujące zdjęcia'}</button> : canApply && batch && batch.slots.length > 0 ? <button type="button" className="admin-button" onClick={() => void action('apply')} disabled={frozen || conflict || record.editorialStatus === 'archived'}>{busy === 'apply' ? <LoaderCircle size={17} className="admin-spinner" /> : <CheckCircle2 size={17} />}{partial ? 'Zapisz gotowe zdjęcia w szkicu' : 'Zapisz zdjęcia w szkicu'}</button> : canResume ? <button type="button" className="admin-button" onClick={() => void action('resume')} disabled={frozen || record.editorialStatus === 'archived'}>{busy === 'resume' ? <LoaderCircle size={17} className="admin-spinner" /> : <RefreshCw size={17} />}{running ? 'Sprawdź i wznów' : 'Kontynuuj pakiet'}</button> : batch?.status === 'applied' ? <Link className="admin-button" href={'/admin/recipes/' + encodeURIComponent(record.id)}>Sprawdź szkic<ArrowUpRight size={16} /></Link> : null}
      <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => void refresh()} disabled={frozen}>{busy === 'refresh' ? <LoaderCircle size={14} className="admin-spinner" /> : <RefreshCw size={14} />}Odśwież stan</button>
      {batch && <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => void checkBilling()} disabled={frozen}>{busy === 'billing' ? <LoaderCircle size={14} className="admin-spinner" /> : <RefreshCw size={14} />}Sprawdź rozliczenie pakietu</button>}
    </div></div>}
    {!loading && !saveDraftFirst && ingredientCount > 0 && <div className="admin-photo-batch-footer"><div><span>Zdjęcia składników</span><p>Przygotujemy fotografie wszystkich {ingredientCount} składników na tle w kolorze serwisu z naturalnym cieniem. Po sprawdzeniu zastąpisz obecne zdjęcia składników i zapiszesz gotowe kadry brakującego dania lub etapów. Zachowamy ich już zapisane zdjęcia.</p>{(ingredientWorkUnresolved || batch?.status === 'blocked') && <p>Najpierw wyjaśnij stan trwających zdjęć składników, aby uniknąć ponownego zlecenia.</p>}</div><div className="admin-photo-batch-actions"><button type="button" className="admin-button is-secondary" onClick={() => void begin('ingredients-paper')} disabled={frozen || !canReplaceIngredients}><Sparkles size={17} />Generuj składniki na tle serwisu</button></div></div>}
    {saveDraftFirst && showStart && missingTotal > 0 && <p className="admin-photo-batch-footnote">Kliknięcie zapisze sprawdzoną propozycję przepisu jako szkic i uruchomi przygotowanie zdjęć.</p>}
  </section>;
}
