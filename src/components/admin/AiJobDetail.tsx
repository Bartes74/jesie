'use client';

import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import { formatRecipeDuration } from '@/lib/recipe-duration';
import { getStepTimerMinutes } from '@/lib/step-timer-policy';
import { MediaImage } from '@/components/MediaImage';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowUpRight, BookOpen, Check, CheckCircle2, ChevronRight, Clock3, ImagePlus, LoaderCircle, RefreshCw, Utensils, X } from 'lucide-react';
import type { AiJob, AiStatus, CreateAiJob } from '@/lib/ai-types';
import { heroCutoutSemanticRetryBrief } from '@/lib/ai-types';
import type { EditorialContent, EditorialRecord } from '@/lib/editorial-types';
import type { Locale } from '@/lib/recipes';
import { RecipePhoto } from '@/components/RecipePhoto';
import { JobRecoveryNotice } from '@/components/admin/JobRecoveryNotice';
import { aiJobFeedback, jobHasOngoingWork, photoRecoveryPollInterval } from '@/lib/ai-job-feedback';
import { PhotoBatchPanel } from '@/components/admin/PhotoBatchPanel';
import { formatIngredientAmount, renderStepText } from '@/lib/quantities';
import { heroPresentationProfile, isGlassHeroPresentation } from '@/lib/hero-presentation';

const statuses: Record<AiStatus, string> = { queued: 'W kolejce', submitting: 'Wysyłanie', generating: 'Generowanie', ready: 'Gotowe do sprawdzenia', failed: 'Generowanie wymaga uwagi', uncertain: 'Sprawdź stan u dostawcy', cancelled: 'Zadanie anulowane', applied: 'Wynik zapisany w szkicu' };
const kinds = { recipe: 'Treść przepisu', hero: 'Zdjęcie dania', ingredient: 'Zdjęcie składnika', step: 'Zdjęcie kroku' };
const active = (status: AiStatus) => status === 'queued' || status === 'submitting' || status === 'generating';
const usd = (value: string) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value));
const date = (value: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const studioMessage = (value: string) => value.replace(/OpenAI(?: API)?/g, 'generator treści').replace(/fal\.ai/g, 'generator zdjęć').replace(/\bAI\b/g, 'generowania');
const photoDescription = (value: string) => value.replace(/^(?:Ilustracja AI|AI illustration):\s*/i, '');
const resultNote = (value: string) => value === 'Ilustracja AI wymaga przeglądu zgodności potrawy, składników i detalu.' ? 'Sprawdź zgodność zdjęcia z potrawą, składnikami i najważniejszym detalem.' : value;
const errorText = (error: unknown) => error instanceof TypeError ? 'Brak połączenia z serwisem. Odśwież stan przed kolejną operacją.' : error instanceof Error ? studioMessage(error.message) : 'Nie udało się połączyć z serwisem.';

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się wczytać zadania.');
  return body;
}

function RetainedPhotoPreview({ jobId }: { jobId: string }) {
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const src = `/api/admin/ai/${encodeURIComponent(jobId)}/photo${attempt ? `?attempt=${attempt}` : ''}`;
  return <section className="admin-ai-result">
    <div className="admin-ai-result-heading"><div><p className="admin-eyebrow">ZACHOWANA FOTOGRAFIA</p><h2>Zdjęcie przed wycięciem tła</h2></div></div>
    <p>Generator przygotował to zdjęcie. Wycięcie tła jest osobnym etapem; poniżej możesz sprawdzić fotografię i porównać ją ze swoimi wskazówkami. Ten podgląd nie zmienia szkicu.</p>
    {unavailable ? <div className="admin-notice is-error" role="status"><AlertCircle size={18} /><div><p>Nie udało się wczytać zachowanej fotografii. Sesja mogła wygasnąć albo plik jest chwilowo niedostępny.</p><button type="button" className="admin-text-link" onClick={() => { setUnavailable(false); setAttempt(value => value + 1); }}>Wczytaj podgląd ponownie</button></div></div> : <figure className="admin-ai-asset-preview">
      {/* Native same-origin image keeps the editor session; the private original must never pass through the public image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="Zachowana fotografia gotowej potrawy przed wycięciem tła" loading="lazy" decoding="async" style={{ width: '100%', height: 'auto' }} onError={() => setUnavailable(true)} />
      <figcaption><h3>Oryginał od generatora</h3><p>Fotografia wymaga sprawdzenia. Nie została zastosowana do przepisu.</p><a href={src} target="_blank" rel="noopener" className="admin-text-link">Otwórz zachowane zdjęcie<ArrowUpRight size={14} /></a></figcaption>
    </figure>}
  </section>;
}

function RecipePreview({ content, locale }: { content: EditorialContent; locale: Locale }) {
  const recipe = content.recipe;
  const units = locale === 'en' ? 'uk' : 'metric';
  const generatedProvenance = recipe.provenance.type === 'demo_ai' || recipe.provenance.type === 'ai_draft';
  return <article className="admin-ai-recipe-preview" lang={locale === 'pl' ? 'pl' : 'en-GB'}>
    <header><p className="admin-eyebrow">{locale === 'pl' ? 'PROPOZYCJA · DO REDAKCJI' : 'DRAFT · FOR REVIEW'}</p><h2>{recipe.title[locale] || (locale === 'pl' ? 'Bez tytułu' : 'Untitled')}</h2><p>{formatRecipeDurationText(recipe.description[locale], locale)}</p><div className="admin-ai-recipe-meta"><span><Utensils size={15} />{recipe.baseServings} {locale === 'pl' ? 'porcji' : 'servings'}</span><span><Clock3 size={15} />{formatRecipeDuration(recipe.times.total, locale)}</span><span>{locale === 'pl' ? 'Miary metryczne' : 'UK measures'}</span></div></header>
    <section><h3>{locale === 'pl' ? 'Składniki' : 'Ingredients'}</h3><ul className="admin-ai-ingredients">{recipe.ingredients.map((item, index) => <li key={item.id}>{(index === 0 || recipe.ingredients[index - 1].group[locale] !== item.group[locale]) && item.group[locale] && <h4>{item.group[locale]}</h4>}<div><span>{item.name[locale]}</span><strong>{formatIngredientAmount(item, recipe.baseServings, recipe.baseServings, units, locale)}</strong></div>{item.note?.[locale] && <p>{formatRecipeDurationText(item.note[locale], locale)}</p>}</li>)}</ul></section>
    <section><h3>{locale === 'pl' ? 'Przygotowanie' : 'Method'}</h3><ol className="admin-ai-method">{recipe.steps.map((step, index) => { const timerMinutes = getStepTimerMinutes(step); return <li key={step.id}><span className="admin-ai-step-number">{String(index + 1).padStart(2, '0')}</span><div><h4>{step.title[locale]}</h4><p>{renderStepText(step, recipe, recipe.baseServings, units, locale)}</p>{timerMinutes !== null && <span className="admin-ai-timer"><Clock3 size={13} />{formatRecipeDuration(timerMinutes, locale)}</span>}</div></li>; })}</ol></section>
    {recipe.equipment[locale].length > 0 && <section><h3>{locale === 'pl' ? 'Potrzebny sprzęt' : 'Equipment'}</h3><p>{recipe.equipment[locale].join(', ')}</p></section>}
    {recipe.tips[locale].length > 0 && <section><h3>{locale === 'pl' ? 'Wskazówki' : 'Tips'}</h3><ul className="admin-ai-tips">{recipe.tips[locale].map((tip, index) => <li key={index}>{formatRecipeDurationText(tip, locale)}</li>)}</ul></section>}
    {recipe.storage[locale] && <section><h3>{locale === 'pl' ? 'Przechowywanie' : 'Storage'}</h3><p>{formatRecipeDurationText(recipe.storage[locale], locale)}</p></section>}
    {recipe.scalingNote?.[locale] && <section><h3>{locale === 'pl' ? 'Zmiana liczby porcji' : 'Scaling the recipe'}</h3><p>{formatRecipeDurationText(recipe.scalingNote[locale], locale)}</p></section>}
    <section className="admin-ai-provenance"><h3>{locale === 'pl' ? 'Informacje redakcyjne' : 'Editorial information'}</h3>{!generatedProvenance && <><p>{recipe.provenance.label[locale]}</p><p>{recipe.provenance.note[locale]}</p></>}<p>{locale === 'pl' ? 'Sprawdzenie w kuchni: ' : 'Kitchen-tested: '}{recipe.provenance.kitchenTested ? locale === 'pl' ? 'tak' : 'yes' : locale === 'pl' ? 'nie' : 'no'}</p>{content.author && <p>{locale === 'pl' ? 'Autor: ' : 'Author: '}{content.author}</p>}{content.sources.length > 0 && <ul>{content.sources.map(source => { const validUrl = /^https?:\/\//i.test(source.url); return <li key={source.id}>{validUrl ? <a href={source.url} className="admin-text-link" target="_blank" rel="noopener noreferrer">{source.title || source.url}<ArrowUpRight size={13} /></a> : <span>{source.title || source.url}</span>}</li>; })}</ul>}</section>
    {content.originalText && <details className="admin-ai-original"><summary>{locale === 'pl' ? 'Oryginalne notatki' : 'Original notes'}</summary><p>{content.originalText}</p></details>}
  </article>;
}

export function AiJobDetail({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<AiJob | null>(null);
  const [record, setRecord] = useState<EditorialRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<'apply' | 'cancel' | 'resume' | 'recover' | 'repair' | null>(null);
  const [error, setError] = useState('');
  const [recordError, setRecordError] = useState('');
  const [notice, setNotice] = useState('');
  const [locale, setLocale] = useState<Locale>('pl');
  const [acknowledgeStale, setAcknowledgeStale] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [recoveryUnconfirmed, setRecoveryUnconfirmed] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const busyRef = useRef(false);
  const photoBusyRef = useRef(false);
  const pendingRecovery = useRef<CreateAiJob | null>(null);
  const endpoint = '/api/admin/ai/' + encodeURIComponent(jobId);

  const loadRecipe = useCallback(async (id: string, signal?: AbortSignal) => {
    try {
      const data = await read<{ recipe: EditorialRecord }>('/api/admin/recipes/' + encodeURIComponent(id), signal);
      setRecord(data.recipe); setAcknowledgeStale(false);
      setRecordError('');
    } catch (err) { if (!signal?.aborted) setRecordError(errorText(err)); }
  }, []);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const data = await read<{ job: AiJob }>(endpoint, signal);
    setJob(data.job);
    await loadRecipe(data.job.recipeId, signal);
  }, [endpoint, loadRecipe]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => reload(controller.signal)).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const isActive = jobHasOngoingWork(job);
  const photoPollInterval = photoRecoveryPollInterval(job);
  useEffect(() => {
    if (!isActive && !photoPollInterval) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let disposed = false;
    let generation = 0;
    let delay = 4000;
    const schedule = () => { if (!disposed && !document.hidden && (isActive || photoRecoveryPollInterval(job))) timer = setTimeout(() => void poll(), delay); };
    const poll = async () => {
      const request = ++generation;
      const currentController = new AbortController();
      controller = currentController;
      try {
        const data = await read<{ job: AiJob }>(endpoint, currentController.signal);
        if (disposed || request !== generation) return;
        if (!jobHasOngoingWork(data.job)) await loadRecipe(data.job.recipeId, currentController.signal);
        if (disposed || request !== generation) return;
        setJob(data.job); delay = 4000;
      } catch { if (!currentController.signal.aborted) delay = Math.min(delay * 2, 60000); }
      finally { if (request === generation) schedule(); }
    };
    const visibility = () => { ++generation; clearTimeout(timer); controller?.abort(); if (!document.hidden) void poll(); };
    schedule(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [endpoint, isActive, job, loadRecipe, photoPollInterval]);

  const refresh = async () => {
    if (busyRef.current || photoBusyRef.current) return;
    setRefreshing(true); setError('');
    try { await reload(); setConflict(false); setAcknowledgeStale(false); } catch (err) { setError(errorText(err)); } finally { setRefreshing(false); }
  };
  const action = async (name: 'apply' | 'cancel' | 'resume' | 'recover') => {
    if (busyRef.current || photoBusyRef.current || !job || (name === 'apply' && !record)) return;
    busyRef.current = true; setBusy(name); setError(''); setNotice('');
    try {
      const response = await fetch(endpoint + '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, ...(name === 'apply' ? { expectedRevision: record!.revision, acknowledgeStale } : {}) }) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setAcknowledgeStale(false); if (body.latest) setRecord(body.latest); }
        throw new Error(body.error || 'Nie udało się wykonać tej operacji.');
      }
      if (!body.job) throw new Error('Nie otrzymaliśmy potwierdzenia. Odśwież stan zadania przed następną operacją.');
      if (body.job.id !== job.id) { router.push('/admin/ai/' + encodeURIComponent(body.job.id)); return; }
      setJob(job.photoSourceJobId ? { ...body.job, photoSourceJobId: job.photoSourceJobId,
        ...(job.photoSourceStatus ? { photoSourceStatus: job.photoSourceStatus } : {}),
        ...(job.manualPhotoComposition ? { manualPhotoComposition: true } : {}) } : body.job);
      if (body.recipe) setRecord(body.recipe);
      setConflict(false); setAcknowledgeStale(false);
      setNotice(name === 'apply' ? 'Wynik zapisano jako nową wersję szkicu. Otwórz edytor, aby sprawdzić przepis.' : name === 'cancel' ? 'Zapisano prośbę o anulowanie. Koszt rozpoczętej pracy może pozostać w rozliczeniu.' : name === 'recover' ? 'Sprawdzono zapisany wynik. Stan przygotowania jest aktualny.' : job.canRestorePhotoContents ? 'Zachowane zdjęcie przekazano do przywrócenia zawartości naczynia. Gotowy kadr sprawdzisz i osobno zastosujesz do szkicu.' : 'Sprawdzono istniejące zgłoszenie u dostawcy.');
    } catch (err) { setError(errorText(err)); } finally { busyRef.current = false; setBusy(null); }
  };
  const repair = async () => {
    if (busyRef.current || photoBusyRef.current || !job || !record) return;
    busyRef.current = true; setBusy('repair'); setError('');
    try {
      const response = await fetch('/api/admin/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        recipeId: job.recipeId, expectedRevision: record.revision, kind: 'hero', imageAction: 'fill_cutout', sourceJobId: job.id,
        brief: apertureCutout ? 'Zachowaj prześwity naczynia z istniejącej maski, bez nowego płatnego wycięcia.' : 'Zachowaj całą potrawę wewnątrz naczynia w istniejącym wycięciu, bez ponownego generowania.', requestKey: crypto.randomUUID(),
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Nie udało się przygotować korekty wycięcia.');
      if (!body.job?.id) throw new Error('Nie otrzymaliśmy potwierdzenia korekty. Odśwież stan przed następną operacją.');
      router.push('/admin/ai/' + encodeURIComponent(body.job.id));
    } catch (err) { setError(errorText(err)); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const recoverBackground = async (semanticRetry = false) => {
    if (busyRef.current || photoBusyRef.current || !job || !record || recordError) return;
    if (job.kind !== 'hero' || job.manualPhotoComposition || job.photoSourceStatus) return;
    if (semanticRetry && !job.canRetryPhotoMask) return;
    if (!pendingRecovery.current) pendingRecovery.current = {
      recipeId: job.recipeId, expectedRevision: record.revision, kind: 'hero', imageAction: 'cutout_result', sourceJobId: job.photoSourceJobId ?? job.id,
      brief: semanticRetry ? heroCutoutSemanticRetryBrief : 'Wytnij tło już zakończonej fotografii, zachowując całe naczynie i potrawę. Bez ponownego generowania zdjęcia.', requestKey: crypto.randomUUID(),
    };
    busyRef.current = true; setBusy('repair'); setError('');
    try {
      const response = await fetch('/api/admin/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingRecovery.current) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500) { pendingRecovery.current = null; setRecoveryUnconfirmed(false); }
        throw new Error(body.error || 'Nie udało się potwierdzić korekty tła.');
      }
      if (!body.job?.id) throw new Error('Nie otrzymaliśmy potwierdzenia korekty. Sprawdź to samo zgłoszenie.');
      pendingRecovery.current = null; setRecoveryUnconfirmed(false);
      router.push('/admin/ai/' + encodeURIComponent(body.job.id));
    } catch (err) {
      if (pendingRecovery.current) setRecoveryUnconfirmed(true);
      setError(errorText(err));
    } finally { busyRef.current = false; setBusy(null); }
  };

  const photoBusyChanged = useCallback((value: boolean) => { photoBusyRef.current = value; setPhotoBusy(value); }, []);
  const preparePhotoBatch = async (): Promise<EditorialRecord> => {
    if (busyRef.current || !job || !record || recordError) throw new Error('Wczytaj aktualny szkic przed przygotowaniem zdjęć.');
    busyRef.current = true; setBusy('apply');
    try {
      // A previous save may have succeeded even if its response was lost.
      const current = await read<{ job: AiJob }>(endpoint);
      setJob(current.job);
      if (current.job.status === 'applied') {
        const data = await read<{ recipe: EditorialRecord }>('/api/admin/recipes/' + encodeURIComponent(current.job.recipeId));
        setRecord(data.recipe); setRecordError('');
        return data.recipe;
      }
      if (current.job.status !== 'ready' || !canApply) throw new Error('Sprawdź propozycję i bieżącą wersję szkicu przed zapisaniem.');
      const response = await fetch(endpoint + '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', expectedRevision: record.revision, acknowledgeStale }) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setAcknowledgeStale(false); if (body.latest) setRecord(body.latest); }
        throw new Error(body.error || 'Nie udało się zapisać propozycji w szkicu.');
      }
      if (!body.job || !body.recipe) throw new Error('Nie otrzymaliśmy potwierdzenia zapisu szkicu. Sprawdź zgłoszenie pakietu ponownie.');
      setJob(body.job); setRecord(body.recipe); setConflict(false); setAcknowledgeStale(false);
      setNotice('Propozycję zapisano w szkicu. Gotowy komplet zdjęć sprawdzisz poniżej.');
      return body.recipe;
    } catch (err) { setError(errorText(err)); throw err; }
    finally { busyRef.current = false; setBusy(null); }
  };

  if (loading) return <div className="admin-loading" role="status"><LoaderCircle className="admin-spinner" size={26} /><p>Wczytuję generowanie…</p></div>;
  if (!job) return <><Link href="/admin/ai" className="admin-breadcrumb"><ArrowLeft size={16} />Studio</Link><div className="admin-empty"><h1>Nie udało się wczytać zadania.</h1><p role="alert">{error || 'Sprawdź adres zadania i odśwież stronę.'}</p><button type="button" className="admin-button is-secondary" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={16} />Wczytaj ponownie</button></div></>;

  const stale = Boolean(record && record.revision !== job.baseRevision);
  const historicalPhotoMask = Boolean(job.kind === 'hero' && job.model === 'fal-ai/sam-3/image' && job.photoSourceJobId && job.photoSourceStatus);
  const ready = !historicalPhotoMask && job.status === 'ready' && Boolean(job.result?.content || job.result?.asset || job.result?.reusedPhoto);
  const canApply = ready && Boolean(record) && !record?.deletedAt && !recordError && record?.editorialStatus !== 'archived' && (!stale || acknowledgeStale) && !conflict;
  const canResume = !historicalPhotoMask && Boolean(job.providerRequestId || job.reuseSourceJobId) && job.status === 'uncertain';
  const canCancel = !historicalPhotoMask && (active(job.status) || job.status === 'uncertain');
  const feedback = aiJobFeedback(job, record?.revision);
  const controlsBusy = Boolean(busy) || photoBusy || job.id !== jobId;
  const confirmedCost = job.costBasis === 'usage' && job.chargedUsd !== null ? job.chargedUsd : null;
  const reusedPhoto = job.result?.reusedPhoto;
  const asset = reusedPhoto || historicalPhotoMask ? null : job.result?.asset;
  const apertureCutout = Boolean(job.heroContainer && ['jar', 'bottle', 'glass', 'sauceboat', 'clay-pot', 'pot', 'pan', 'baking-dish'].includes(job.heroContainer))
    || (!job.heroContainer && asset?.styleProfile === heroPresentationProfile && (isGlassHeroPresentation(record?.content.recipe.heroPresentation)
      || ['sauceboat', 'clay-pot', 'pot', 'pan', 'baking-dish'].includes(record?.content.recipe.heroPresentation?.container ?? '')));
  const paperIngredient = job.kind === 'ingredient' && (asset?.styleProfile ?? reusedPhoto?.styleProfile) === 'jesie-ingredient-paper-studio-v3';
  const target = record && job.targetId ? job.kind === 'ingredient' ? record.content.recipe.ingredients.find(item => item.id === job.targetId)?.name.pl : record.content.recipe.steps.find(item => item.id === job.targetId)?.title.pl : null;
  const canRecoverBackground = job.kind === 'hero' && job.provider === 'fal' && job.model === 'openai/gpt-image-2.5/sunburst/text-to-image'
    && !job.manualPhotoComposition && job.status === 'failed' && job.errorCode === 'AI_TRANSPARENCY_MISSING' && Boolean(job.providerRequestId) && !job.result && !job.photoRecovery;
  const retainedPhotoId = job.kind === 'hero' && !job.result && !historicalPhotoMask
    ? job.photoSourceJobId ?? (job.provider === 'fal' && job.model === 'openai/gpt-image-2.5/sunburst/text-to-image'
      && job.status === 'failed' && job.errorCode === 'AI_TRANSPARENCY_MISSING' && job.providerRequestId ? job.id : null)
    : null;
  const statusDescription: Record<AiStatus, string> = {
    queued: 'Zlecenie zostało zapisane. Czeka na rozpoczęcie pracy.',
    submitting: 'Przekazujemy zlecenie dostawcy. Możesz zamknąć tę stronę i wrócić później.',
    generating: 'Dostawca przygotowuje materiał. Stan odświeża się automatycznie, gdy ta strona jest widoczna.',
    ready: 'Przejrzyj wynik i zastosuj go do szkicu, gdy będzie gotowy do dalszej redakcji.',
    failed: 'Sprawdź komunikat poniżej. Koszt rozpoczętej pracy może zostać rozliczony.',
    uncertain: job.reuseSourceJobId ? 'Pierwsze zadanie tego składnika wymaga sprawdzenia. Odczytamy jego istniejący wynik bez nowego płatnego zlecenia.' : job.providerRequestId ? 'Mamy identyfikator zgłoszenia. Możemy sprawdzić jego stan bez zlecania nowego generowania.' : 'Nie otrzymaliśmy identyfikatora dostawcy. Stan i koszt wymagają wyjaśnienia przed kolejnym zleceniem.',
    cancelled: 'Wynik tego zadania nie trafi do przepisu. Rozpoczęte generowanie może nadal wiązać się z kosztem.',
    applied: 'Materiał trafił do nowej wersji szkicu. Dalszą redakcję i publikację wykonasz w edytorze przepisu.',
  };

  return <div className="admin-ai-detail">
    <nav className="admin-breadcrumb" aria-label="Okruszki"><Link href="/admin/ai"><ArrowLeft size={16} />Studio</Link><ChevronRight size={13} /><span>{kinds[job.kind]}</span></nav>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">{kinds[job.kind].toUpperCase()}</p><h1>{job.recipeTitle || 'Bez tytułu'}</h1><p>{target ? target + ' · ' : ''}Na podstawie wersji {job.baseRevision} · {date(job.createdAt)}</p></div><button type="button" className="admin-button is-secondary" onClick={() => void refresh()} disabled={refreshing || controlsBusy}><RefreshCw size={16} className={refreshing ? 'admin-spinner' : ''} />Odśwież stan</button></div>
    {job.photoSourceJobId && <p className="admin-ai-help"><Link className="admin-text-link" href={`/admin/ai/${encodeURIComponent(job.photoSourceJobId)}`}>{historicalPhotoMask ? 'Zobacz gotowe zdjęcie źródłowe' : 'Zobacz źródłową fotografię i jej rozliczenie'}<ChevronRight size={14} /></Link></p>}
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><div><p>{error}</p>{conflict && <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => void refresh()} disabled={refreshing || controlsBusy}>Wczytaj aktualną wersję i sprawdź wynik ponownie</button>}</div></div>}
    {notice && <div className="admin-notice is-success" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}
    <div className="admin-ai-detail-grid"><div className="admin-ai-result-column">
      {!feedback && <section className={'admin-ai-progress is-' + job.status} aria-live="polite"><span className="admin-ai-progress-icon">{isActive ? <LoaderCircle className="admin-spinner" size={26} /> : job.status === 'applied' || job.status === 'ready' ? <Check size={26} /> : job.status === 'cancelled' ? <X size={26} /> : <AlertCircle size={26} />}</span><div><h2>{statuses[job.status]}</h2><p>{statusDescription[job.status]}</p></div></section>}
      <JobRecoveryNotice job={job} currentRevision={record?.revision} disabled={controlsBusy || refreshing || Boolean(recordError) || Boolean(record?.deletedAt) || record?.editorialStatus === 'archived'} busy={busy === 'recover' || busy === 'resume'} onRecover={() => void action('recover')} onResume={() => void action('resume')} onRefresh={() => void refresh()} />
      {job.photoRecovery && <p className="admin-ai-help">Osobne wycięcie tła: {job.photoRecovery.costBasis === 'usage' && job.photoRecovery.chargedUsd !== null ? usd(job.photoRecovery.chargedUsd) : 'koszt oczekuje na potwierdzenie'}. Rozliczenie źródłowej fotografii znajdziesz obok.</p>}
      {job.photoRecovery?.status === 'failed' && job.photoRecovery.errorCode === 'AI_MASK_NOT_FOUND' && <p className="admin-ai-help" role="status">Automatyczne wycięcie tła nie zwróciło maski. Fotografia jest zachowana; poniżej możesz obejrzeć oryginał i sprawdzić, czy uwzględnia Twój opis.</p>}
      {!historicalPhotoMask && (!feedback || job.kind !== 'recipe') && job.errorMessage && <div className="admin-notice is-error"><AlertCircle size={18} /><div><p>{studioMessage(job.errorMessage)}</p>{job.errorCode && <details><summary>Szczegóły diagnostyczne</summary><small>Kod: {job.errorCode.replace(/^AI_/, '')}</small></details>}</div></div>}
      {historicalPhotoMask && job.errorMessage && <details className="admin-ai-result-notes"><summary>Wcześniejsza próba wycięcia tła</summary><p>{studioMessage(job.errorMessage)}</p><p>Ten komunikat dotyczy poprzedniej korekty. Gotowe zdjęcie i jego aktualny stan znajdziesz w zleceniu źródłowym.</p></details>}
      {retainedPhotoId && <RetainedPhotoPreview key={retainedPhotoId} jobId={retainedPhotoId} />}
      {canRecoverBackground && <section className="admin-ai-result-notes"><h3>Zachowaj gotowe zdjęcie</h3><p>Fotografia powstała, ale wymaga wycięcia tła. Pobierzemy jej istniejący wynik i przygotujemy osobną korektę. Koszt zakończonej fotografii pozostaje w rozliczeniu.</p><button type="button" className="admin-button is-secondary" disabled={controlsBusy || refreshing || !record || Boolean(record.deletedAt) || Boolean(recordError) || record?.editorialStatus === 'archived'} onClick={() => void recoverBackground()}>{busy === 'repair' ? <LoaderCircle size={16} className="admin-spinner" /> : <RefreshCw size={16} />}{recoveryUnconfirmed ? 'Sprawdź zgłoszenie korekty' : 'Wytnij tło gotowego zdjęcia'}</button>{recoveryUnconfirmed && <p>Zgłoszenie mogło zostać zapisane. Sprawdzimy ten sam identyfikator, bez tworzenia kolejnej korekty.</p>}<p>Nie zlecamy ponownie fotografii. Wynik wycięcia sprawdzisz i zastosujesz ręcznie do szkicu.</p></section>}
      {job.canRetryPhotoMask && !job.manualPhotoComposition && !historicalPhotoMask && <section className="admin-ai-result-notes"><h3>Dokończ wycięcie gotowego zdjęcia</h3><p>Poprzednia próba nie zwróciła maski. Możesz zlecić jedną płatną próbę ze zmienionym wskazaniem naczynia. Wykorzystamy tę samą fotografię; wycięcie ma osobne rozliczenie.</p><button type="button" className="admin-button is-secondary" disabled={controlsBusy || refreshing || !record || Boolean(record.deletedAt) || Boolean(recordError) || record?.editorialStatus === 'archived'} onClick={() => void recoverBackground(true)}>{busy === 'repair' ? <LoaderCircle size={16} className="admin-spinner" /> : <RefreshCw size={16} />}{recoveryUnconfirmed ? 'Sprawdź zgłoszenie korekty' : 'Ponów samo wycięcie tła'}</button>{recoveryUnconfirmed && <p>Sprawdzimy ten sam identyfikator zgłoszenia, bez tworzenia kolejnej próby.</p>}<p>Gotowy wynik sprawdzisz i osobno zastosujesz do szkicu.</p></section>}
      {job.result && (job.result.content || asset || reusedPhoto) ? <section className="admin-ai-result"><div className="admin-ai-result-heading"><div><p className="admin-eyebrow">PODGLĄD WYNIKU</p><h2>{job.result.content ? 'Przepis do sprawdzenia' : reusedPhoto ? 'Zdjęcie z biblioteki' : 'Gotowy kadr'}</h2></div><div className="admin-locale-tabs" aria-label="Język podglądu"><button type="button" aria-pressed={locale === 'pl'} onClick={() => setLocale('pl')}>PL</button><button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN · UK</button></div></div>
        {job.result.content && <RecipePreview content={job.result.content} locale={locale} />}
        {asset && <figure className={'admin-ai-asset-preview' + (paperIngredient ? ' is-ingredient-paper' : '')}><MediaImage src={asset.src} alt={photoDescription(asset.alt[locale])} width={asset.width} height={asset.height} sizes="(max-width: 800px) calc(100vw - 78px), (max-width: 1250px) calc(100vw - 600px), min(840px, calc(100vw - 650px))" maximumWidth={1280} /><figcaption><p className="admin-eyebrow">ZDJĘCIE</p><h3>{formatRecipeDurationText(photoDescription(asset.caption[locale] || asset.alt[locale]), locale)}</h3><p>{photoDescription(asset.alt[locale])}</p><div><span>{asset.width} × {asset.height} px</span><a href={asset.src} target="_blank" rel="noopener" className="admin-text-link">Otwórz pełny kadr<ArrowUpRight size={14} /></a></div></figcaption></figure>}
        {reusedPhoto && <figure className={'admin-ai-asset-preview' + (paperIngredient ? ' is-ingredient-paper' : '')}><RecipePhoto media={reusedPhoto} locale={locale} sizes="(max-width: 800px) min(360px, calc(100vw - 78px)), 360px" legacySizes="(max-width: 900px) 100vw, 65vw" maximumWidth={960} /><figcaption><p className="admin-eyebrow">Z BIBLIOTEKI</p><h3>{photoDescription(reusedPhoto.alt[locale])}</h3><p>Wykorzystujemy istniejącą fotografię tego produktu w zgodnej postaci i stylu. Nie zlecono nowego zdjęcia.</p></figcaption></figure>}
        {ready && asset && job.kind === 'hero' && job.model === 'fal-ai/sam-3/image' && <div className="admin-ai-result-notes"><h3>{apertureCutout ? 'Prześwity naczynia' : 'Zawartość naczynia'}</h3><p>{apertureCutout ? 'Zachowaj przezroczystość szkła lub otworu uchwytu. Korekta wykorzysta istniejące wycięcie, bez zlecania nowego zdjęcia.' : 'Jeśli wycięcie usunęło również potrawę ze środka miski lub talerza, przywróć ją z oryginalnego zdjęcia.'} Korekta jest bezpłatna i trafi do osobnego podglądu.</p><button type="button" className="admin-button is-secondary" disabled={controlsBusy || refreshing || !record || Boolean(record.deletedAt) || Boolean(recordError)} onClick={() => void repair()}>{busy === 'repair' ? <LoaderCircle size={16} className="admin-spinner" /> : <RefreshCw size={16} />}{apertureCutout ? 'Zachowaj prześwity' : 'Zachowaj zawartość naczynia'}</button></div>}
        {job.result.notes.length > 0 && <div className="admin-ai-result-notes"><h3>Uwagi do wyniku</h3><ul>{job.result.notes.map((note, index) => <li key={index}>{resultNote(note)}</li>)}</ul></div>}
      </section> : !feedback && <div className="admin-ai-result-placeholder">{job.kind === 'recipe' ? <BookOpen size={44} strokeWidth={1.1} /> : <ImagePlus size={44} strokeWidth={1.1} />}<h2>{isActive ? 'Tutaj pojawi się wynik.' : 'Nie ma jeszcze wyniku do podglądu.'}</h2><p>{isActive ? 'Możesz wrócić do studia. Zadanie ma własny, stały adres.' : 'Bieżący stan i dostępne działania znajdziesz obok.'}</p><Link href="/admin/ai" className="admin-text-link">Wróć do studia<ChevronRight size={14} /></Link></div>}
      {job.kind === 'recipe' && (job.status === 'ready' || job.status === 'applied') && record && !record.deletedAt && !recordError && <PhotoBatchPanel key={job.id} record={record} previewContent={job.result?.content ?? undefined} sourceJobId={job.id} saveDraftFirst={job.status === 'ready'} canStart={job.status === 'applied' || canApply} disabled={controlsBusy || refreshing} beforeStart={preparePhotoBatch} onRecipeUpdated={setRecord} onBusyChange={photoBusyChanged} />}
    </div><aside className="admin-ai-detail-rail">
      <section className="admin-ai-apply-panel"><p className="admin-eyebrow">SZKIC PRZEPISU</p><h2>{historicalPhotoMask ? 'Fotografia jest odzyskana.' : job.status === 'applied' ? 'Zapisane.' : !ready ? 'Twój przepis jest zachowany.' : 'Ty decydujesz.'}</h2>{historicalPhotoMask ? <><p>{job.photoSourceStatus === 'applied' ? 'Odzyskane zdjęcie źródłowe zostało zapisane w szkicu. Tutaj pozostaje historia wcześniejszej korekty tła.' : 'Gotowy kadr znajdziesz w zleceniu źródłowym. Otwórz go, aby sprawdzić zdjęcie i zastosować je do szkicu.'}</p><Link className="admin-button" href={'/admin/ai/' + encodeURIComponent(job.photoSourceJobId!)}>Zobacz gotowe zdjęcie<ChevronRight size={17} /></Link></> : job.status === 'applied' ? <><p>Wynik zastosowano do wersji {job.appliedRevision}. Przejdź do przepisu i sprawdź całość.</p><Link className="admin-button" href={'/admin/recipes/' + encodeURIComponent(job.recipeId)}>Otwórz edytor<ChevronRight size={17} /></Link></> : !ready ? <><p>{job.kind !== 'recipe' ? 'Gotowy kadr sprawdzisz na stronie wyniku. Zdjęcie trafi do szkicu po Twoim osobnym zastosowaniu.' : isActive ? 'Po zakończeniu przygotowania przeczytasz przepis i zaakceptujesz treść przed generowaniem grafik.' : 'Wróć do przepisu, aby sprawdzić zapisane wskazówki i kontynuować przygotowanie.'}</p><Link className="admin-button is-secondary" href={'/admin/recipes/' + encodeURIComponent(job.recipeId)}>Otwórz przepis<ChevronRight size={17} /></Link><span className="admin-ai-apply-footnote">Publikacja wymaga Twojej osobnej decyzji.</span></> : <>
        <p>{job.kind === 'recipe' ? 'Zastosowanie zastąpi treść bieżącego szkicu przygotowaną propozycją i utworzy nową wersję przepisu.' : 'Zastosowanie przypisze to zdjęcie do wybranego miejsca w przepisie i utworzy nową wersję szkicu.'}</p>
        {recordError && <div className="admin-notice is-error" role="alert"><AlertCircle size={16} /><span>{recordError}</span></div>}
        {record && <div className="admin-ai-revision-comparison"><div><span>Podstawa generowania</span><strong>Wersja {job.baseRevision}</strong></div><div><span>Bieżący szkic</span><strong>Wersja {record.revision}</strong></div></div>}
        {ready && stale && <div className="admin-ai-stale"><AlertCircle size={18} /><p>Przepis zmienił się podczas generowania. Porównaj wynik z bieżącą treścią, zanim go zastosujesz.</p><Link className="admin-text-link" href={'/admin/recipes/' + encodeURIComponent(job.recipeId)} target="_blank" rel="noopener">Otwórz bieżący szkic<ArrowUpRight size={13} /></Link><label className="admin-checkbox"><input type="checkbox" checked={acknowledgeStale} onChange={event => setAcknowledgeStale(event.target.checked)} disabled={controlsBusy} /><span>Sprawdziłem zmianę wersji i chcę zastosować ten wynik do bieżącego szkicu.</span></label></div>}
        {record?.deletedAt && <p className="admin-ai-help">Przepis jest w Koszu. Wynik pozostaje w podglądzie; przywróć przepis w edytorze przed zastosowaniem.</p>}
        {ready && record?.editorialStatus === 'archived' && <p className="admin-ai-help">Przepis jest w archiwum. Przywróć go w edytorze przed zastosowaniem wyniku.</p>}
        <button type="button" className="admin-button" disabled={!canApply || controlsBusy || refreshing} onClick={() => void action('apply')}>{busy === 'apply' ? <LoaderCircle size={18} className="admin-spinner" /> : <Check size={18} />}Zastosuj do szkicu</button>
        <span className="admin-ai-apply-footnote">Publikacja wymaga osobnej decyzji w edytorze.</span>
      </>}</section>
      <section className="admin-ai-detail-cost"><h3>Koszt zadania</h3><dl><div><dt>{confirmedCost === null ? 'Rozliczenie' : 'Potwierdzony koszt'}</dt><dd>{confirmedCost === null ? 'Oczekuje na potwierdzenie' : usd(confirmedCost)}</dd></div></dl><p>{confirmedCost !== null && Number(confirmedCost) === 0 && (reusedPhoto || job.model === 'jesie/step-photo-21-9' || job.model === 'jesie/hero-cutout-filled' || job.reuseSourceJobId) ? 'Wykorzystano istniejący materiał. Bez nowego płatnego zlecenia.' : confirmedCost !== null ? 'Kwota wynika z rozliczonego użycia u dostawcy.' : 'Koszt pozostaje nieznany do czasu potwierdzenia przez dostawcę.'}</p>{job.usage && <details><summary>Zużycie tokenów</summary><p>Wejście: {job.usage.inputTokens.toLocaleString('pl-PL')}<br />Wyjście: {job.usage.outputTokens.toLocaleString('pl-PL')}</p></details>}</section>
      {(canResume || canCancel) && <section className="admin-ai-task-actions"><h3>Działania</h3>{canResume && <><p>{job.reuseSourceJobId ? 'Sprawdź istniejące zdjęcie z pierwszego zadania tego składnika. Bez nowego płatnego zlecenia.' : 'Sprawdź zapisane zgłoszenie u dostawcy. To działanie nie rozpoczyna nowego generowania.'}</p><button type="button" className="admin-button is-secondary" disabled={controlsBusy || refreshing} onClick={() => void action('resume')}>{busy === 'resume' ? <LoaderCircle size={16} className="admin-spinner" /> : <RefreshCw size={16} />}{job.reuseSourceJobId ? 'Sprawdź istniejące zdjęcie' : 'Sprawdź u dostawcy'}</button></>}{canCancel && <><button type="button" className="admin-button is-subtle" disabled={controlsBusy || refreshing} onClick={() => void action('cancel')}>{busy === 'cancel' ? <LoaderCircle size={16} className="admin-spinner" /> : <X size={16} />}Poproś o anulowanie</button><p>Anulowanie nie gwarantuje zatrzymania już rozpoczętej pracy ani zwrotu jej kosztu.</p></>}</section>}
      <section className="admin-ai-job-context"><h3>Zlecenie</h3><dl><div><dt>Usługa</dt><dd>{job.kind === 'recipe' ? 'Generator treści' : 'Generator zdjęć'}</dd></div><div><dt>Model</dt><dd>{job.model}</dd></div><div><dt>Zlecił(a)</dt><dd>{job.createdByName}</dd></div><div><dt>Aktualizacja</dt><dd>{date(job.updatedAt)}</dd></div></dl>{job.brief && <details open><summary>Twoje wskazówki</summary><p>{job.brief}</p></details>}<details><summary>Identyfikatory zadania</summary><p>jesie.pl: {job.id}</p><p>Dostawca: {job.providerRequestId || 'Nie otrzymano identyfikatora'}</p></details><Link className="admin-text-link" href={'/admin/recipes/' + encodeURIComponent(job.recipeId)}>Otwórz przepis<ChevronRight size={14} /></Link></section>
    </aside></div>
  </div>;
}
