'use client';

import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, ArrowUpRight, Check, CheckCircle2, ChevronRight, Clock3, Globe2, LoaderCircle, Pause, Play, Radar, RefreshCw, Search, Sprout, X } from 'lucide-react';
import type { TrendCandidate, TrendDashboard, TrendPlatform, TrendRun, TrendRunAction, TrendRunStatus } from '@/lib/trend-types';
import type { EditorialRecord } from '@/lib/editorial-types';
import type { Locale } from '@/lib/recipes';
import type { PhotoCostReconciliationReport } from '@/lib/photo-cost-reconciliation-types';
import { formatSubstitutionAmount } from '@/lib/pantry';
import { publicSourceUrl } from '@/server/trends/ranking';
import { sourceDomains } from '@/lib/trend-sources';
import { TrendPhotos } from './TrendPhotos';

const labels: Record<TrendRunStatus, string> = { queued: 'W kolejce', searching: 'Szukam inspiracji', generating: 'Przygotowuję przepis', awaiting_review: 'Do Twojego sprawdzenia', no_candidate: 'Starszy wynik bez przepisu', paused: 'Wstrzymano', failed: 'Wymaga uwagi', uncertain: 'Do wyjaśnienia', rejected: 'Odrzucono', published: 'Opublikowano' };
const platforms: { id: TrendPlatform; name: string }[] = [{ id: 'instagram', name: 'Instagram' }, { id: 'tiktok', name: 'TikTok' }, { id: 'pinterest', name: 'Pinterest' }, { id: 'youtube', name: 'YouTube' }, { id: 'web', name: 'Portale kulinarne' }];
const active = (run: TrendRun) => ['queued', 'searching', 'generating'].includes(run.status);
const usd = (value: string) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
const date = (value: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const safeMessage = (value: string) => value.replace(/OpenAI(?: API)?/g, 'usługa treści').replace(/fal\.ai/g, 'usługa fotografii').replace(/\bAI\b/g, 'generowania');
const errorText = (error: unknown) => error instanceof TypeError ? 'Brak połączenia. Odśwież dane przed kolejną operacją.' : error instanceof Error ? safeMessage(error.message) : 'Nie udało się wczytać danych.';
type RunDetail = { run: TrendRun; candidates: TrendCandidate[]; recipe?: EditorialRecord | null };
const researchOutcomes = {
  empty_discovery: 'Wyszukiwanie nie wskazało żadnej potrawy. To brak propozycji w tym przebiegu, a nie potwierdzenie braku trendów w sieci.',
  unverified_sources: 'Znaleziono potrawy, ale nie udało się potwierdzić ich źródeł. Szczegóły poniżej pokazują, które materiały wymagają sprawdzenia.',
  insufficient_evidence: 'Zebrane potrawy nie spełniły wszystkich kryteriów. Zachowaliśmy propozycje i powody, dla których nie przygotowano przepisu.',
  selected: 'Wybrano jedną potrawę do opracowania. Podstawa wyboru jest zapisana przy przepisie.',
};
const discoveryOutcomes = {
  empty_discovery: 'Wyszukiwanie nie wskazało potrawy. Przepis wybrano z lokalnych propozycji.',
  unverified_sources: 'Wyszukiwanie wskazało potrawy, ale ich materiały nie uzyskały potwierdzenia. Wybór inspiracji nie potwierdza trendu.',
  insufficient_evidence: 'Zebrane materiały nie spełniły wszystkich kryteriów trendu. Zachowaliśmy powody brakujących potwierdzeń.',
  qualified: 'Wyszukiwanie dostarczyło potrawę spełniającą kryteria trendu.',
};
const isConfirmedTrend = (candidate: TrendCandidate) => candidate.eligible && !candidate.editorChoice && !candidate.automaticSelection;
const automaticSelectionLabels = { research: 'Inspiracja z wyszukiwania', seasonal: 'Inspiracja sezonowa', catalog: 'Powrót do katalogu' };
const selectionDescriptions = {
  editor: 'Inspiracja wybrana przez Ciebie. Kompletny przepis trafi do Twojego przeglądu, bez oznaczenia „Popularne teraz”.',
  inspiration: 'Radar automatycznie wybrał inspirację z wyszukiwania. Nie ma pełnego potwierdzenia trendu, więc przepis nie otrzyma oznaczenia „Popularne teraz”.',
  seasonal: 'Radar automatycznie wybrał potrawę z lokalnego banku sezonowych inspiracji. Wybór nie jest potwierdzeniem popularności w sieci.',
  catalog: 'Radar wybrał istniejący przepis z własnego katalogu, ponieważ wyczerpano nowe propozycje. Trafia on do Twojego przeglądu bez ponownego opracowania i fotografii. Ten wybór nie odnawia oznaczenia „Popularne teraz”.',
};
function selectionDescription(run: TrendRun, candidate?: TrendCandidate) {
  if (run.selectionBasis && run.selectionBasis !== 'trend') return selectionDescriptions[run.selectionBasis];
  if (candidate?.automaticSelection) return selectionDescriptions[candidate.automaticSelection.basis === 'research' ? 'inspiration' : candidate.automaticSelection.basis];
  return null;
}
function candidateLabel(candidate: TrendCandidate) {
  if (candidate.editorChoice) return 'Twoja inspiracja';
  if (candidate.automaticSelection) return automaticSelectionLabels[candidate.automaticSelection.basis];
  return candidate.selected ? 'Wybrany trend' : isConfirmedTrend(candidate) ? 'Potwierdzony trend' : 'Brakuje potwierdzeń trendu';
}
const researchIssueLabels: Record<string, string> = {
  date_stale: 'Materiał starszy niż 14 dni',
  date_future: 'Data publikacji jest w przyszłości',
  duplicate_source: 'Powtórzony odnośnik',
  duplicate_quote: 'Powielony materiał',
  uncited_url: 'Odnośnik niepotwierdzony w wynikach wyszukiwania',
  verification_budget: 'Materiał poza limitem weryfikacji tego przebiegu',
  unsafe_redirect: 'Przekierowanie poza dozwolony zakres źródeł',
  unsupported_content: 'Materiał niedostępny w obsługiwanym formacie',
  response_too_large: 'Materiał przekroczył limit odczytu',
  date_unknown: 'Brak możliwej do potwierdzenia daty publikacji',
  quote_missing: 'Fragment nie został potwierdzony w materiale',
  interest_unverified: 'Niepotwierdzone zainteresowanie potrawą',
  creator_unknown: 'Niepotwierdzona tożsamość autora',
  invalid_url: 'Nieprawidłowy adres',
  unsupported_domain: 'Źródło poza zakresem monitoringu',
  not_retrieved: 'Odnośnik niepotwierdzony w wynikach wyszukiwania',
  unavailable: 'Nie udało się odczytać materiału',
  missing_date: 'Brak możliwej do potwierdzenia daty publikacji',
  invalid_date: 'Nieprawidłowa data publikacji',
  date_mismatch: 'Data nie zgadza się z materiałem źródłowym',
  missing_quote: 'Brak wystarczającego fragmentu źródłowego',
  quote_mismatch: 'Fragment nie został potwierdzony w materiale',
  stale_source: 'Materiał starszy niż 14 dni',
  future_source: 'Data publikacji jest w przyszłości',
  duplicate_url: 'Powtórzony odnośnik',
  duplicate_excerpt: 'Powielony materiał',
  unverified_creator: 'Niepotwierdzona tożsamość autora',
  unverified_interest: 'Niepotwierdzone zainteresowanie potrawą',
};
const researchIssueText = (reason: string) => researchIssueLabels[reason] || safeMessage(reason);
const monitoredSourceDomains = new Set(sourceDomains);
const sourceLink = (value: string) => { const normal = publicSourceUrl(value); return normal && monitoredSourceDomains.has(new URL(normal).hostname.replace(/^(?:www|m)\./, '')) ? normal : null; };

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się wczytać danych.');
  return body;
}

export function TrendsDashboard({ runId, canManage = false, budgetOnly = false }: { runId?: string; canManage?: boolean; budgetOnly?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<TrendDashboard | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reconciliation, setReconciliation] = useState<PhotoCostReconciliationReport | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [acknowledgedAutoPause, setAcknowledgedAutoPause] = useState<string | null>(null);
  const busyRef = useRef(false);
  const manualRequestKey = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    const [dashboard, requestedRun] = await Promise.all([read<TrendDashboard>('/api/admin/trends', signal), runId ? read<RunDetail>('/api/admin/trends/' + encodeURIComponent(runId), signal) : Promise.resolve(null)]);
    const latestRunId = !runId ? dashboard.runs[0]?.id : undefined;
    const run = requestedRun ?? (latestRunId ? await read<RunDetail>('/api/admin/trends/' + encodeURIComponent(latestRunId), signal) : null);
    if (!signal?.aborted && version === requestVersion.current) { setData(dashboard); setDetail(run); }
  }, [runId]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const hasActive = Boolean(data?.runs.some(active) || (detail && active(detail.run)));
  const automationEnabled = Boolean(data?.automation.enabled);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let disposed = false;
    let generation = 0;
    const interval = hasActive ? 5000 : 30000;
    let delay = interval;
    const schedule = () => { if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), delay); };
    const poll = async () => {
      if (busyRef.current) { schedule(); return; }
      const localGeneration = ++generation;
      const localController = new AbortController();
      controller = localController;
      try {
        await reload(localController.signal);
        if (!disposed && localGeneration === generation && !localController.signal.aborted) { delay = interval; setConnectionError(''); }
      } catch (err) {
        if (!disposed && localGeneration === generation && !localController.signal.aborted) { delay = Math.min(60_000, delay * 2); setConnectionError(errorText(err)); }
      } finally { if (localGeneration === generation && !localController.signal.aborted) schedule(); }
    };
    const visibility = () => { clearTimeout(timer); generation++; controller?.abort(); if (!document.hidden) void poll(); };
    schedule(); document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', visibility);
    return () => { disposed = true; generation++; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', visibility); };
  }, [hasActive, automationEnabled, reload]);

  const refresh = async () => { setRefreshing(true); setError(''); try { await reload(); setConnectionError(''); } catch (err) { setError(errorText(err)); } finally { setRefreshing(false); } };
  const mutate = async (url: string, method: string, body: unknown, message: string, onRejected?: () => void) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { if (response.status < 500) onRejected?.(); throw new Error(result.error || 'Nie udało się potwierdzić operacji. Odśwież stan.'); }
      await reload(); setAcknowledgedAutoPause(null); setNotice(result.skipped ? 'Codzienne wyszukiwanie jest wyłączone. Jego stan zmienisz w panelu inspiracji.' : message);
      if (result.run?.id && (!runId || result.run.id !== runId)) router.push('/admin/trends/' + encodeURIComponent(result.run.id));
      return true;
    } catch (err) { setError(errorText(err)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };

  const startManual = async () => {
    if (busyRef.current) return;
    const requestKey = manualRequestKey.current ??= crypto.randomUUID();
    if (await mutate('/api/admin/trends', 'POST', { action: 'manual', requestKey }, 'Uruchomiono nowy przebieg ręczny.')) manualRequestKey.current = null;
  };

  const reconcileCosts = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/trends/reconcile-photo-costs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reconcile' }) });
      const body = await response.json();
      if (!response.ok || !body.report) throw new Error(body.error || 'Nie udało się odczytać rachunków radaru.');
      setReconciliation(body.report); await reload();
    } catch (err) { setError(errorText(err)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  if (loading) return <div className="admin-loading" role="status"><LoaderCircle className="admin-spinner" size={26} /><p>Wczytuję radar kulinarny…</p></div>;
  if (!data) return <div className="admin-empty"><Radar size={36} /><h1>Radar czeka na połączenie.</h1><p role="alert">{error || 'Dane są chwilowo niedostępne.'}</p><button type="button" className="admin-button is-secondary" onClick={() => void refresh()} disabled={refreshing}>Wczytaj ponownie</button></div>;
  const selectedRun = detail?.run ?? data.runs[0];
  const candidates = detail?.candidates ?? data.candidates.filter(candidate => candidate.runId === selectedRun?.id);
  const selected = candidates.find(candidate => candidate.selected || candidate.id === selectedRun?.candidateId);
  const selectedDescription = selectedRun ? selectionDescription(selectedRun, selected) : null;
  const configuration = data.configuration;
  const automation = data.automation;
  const automationRequested = data.settings.enabled;
  const autoPauseKey = data.settings.autoPauseReason ? data.settings.autoPauseToken ?? null : null;
  const pauseAcknowledged = Boolean(autoPauseKey && acknowledgedAutoPause === autoPauseKey);
  const runAction = (action: TrendRunAction) => selectedRun && mutate('/api/admin/trends/' + encodeURIComponent(selectedRun.id) + '/actions', 'POST', action, action.action === 'reject' ? 'Kandydat został odrzucony.' : action.action === 'pause' ? 'Przebieg został wstrzymany.' : action.action === 'reverify' ? 'Ponownie sprawdzono zachowany wynik i wybrano przepis. Koszt opracowania pokażemy po rozliczeniu.' : action.action === 'prepare_inspiration' ? 'Rozpoczęto opracowanie tekstu wybranej inspiracji.' : 'Wznowiono przygotowanie tekstu.');

  const notices = <>{(error || connectionError) && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><span>{error || connectionError}</span></div>}
    {notice && <div className="admin-notice is-success" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}

    {reconciliation && <div className="admin-notice" role="status"><RefreshCw size={18} /><div><p>Sprawdzono {reconciliation.scannedJobs} zakończonych zdjęć radaru. Uzgodniono {reconciliation.reconciledJobs}; na rachunek czeka {reconciliation.pendingJobs}. Potwierdzone koszty: {usd(reconciliation.before.usedUsd)} → {usd(reconciliation.after.usedUsd)}.</p><p>{reconciliation.read.status === 'forbidden' || reconciliation.read.status === 'unauthenticated' ? 'Dostawca nie udostępnił rachunków. Sprawdź dostęp do rozliczeń; niepotwierdzone koszty pozostają do rozliczenia.' : reconciliation.read.status === 'not_configured' ? 'Dostęp do rachunków zdjęć nie jest skonfigurowany. Niepotwierdzone koszty pozostają do rozliczenia.' : reconciliation.read.status === 'unavailable' || reconciliation.read.status === 'invalid' ? 'Nie udało się potwierdzić rachunków. Sprawdź je ponownie później.' : reconciliation.pendingJobs ? 'Niepotwierdzone koszty nie są wliczone do zestawienia.' : 'Rachunki sprawdzono. Aktualne koszty widzisz poniżej.'}</p></div></div>}</>;
  const budgetPanel = <section id="radar-budget"><p className="admin-eyebrow">KOSZTY RADARU</p><h2>{usd(data.budget.usedUsd)} <small>Potwierdzone w tym miesiącu (czas Warszawy)</small></h2><p>Wyszukiwanie, treść i fotografie. Do rozliczenia: <strong>{data.budget.pendingCostCount ?? 0}</strong> zleceń. Kwoty bez potwierdzenia nie są wliczone do kosztów.</p><p>Generowanie działa bez limitów wydatków i rezerwacji.</p>{canManage && <><button type="button" className="admin-button is-secondary" disabled={busy || refreshing} onClick={() => void reconcileCosts()}><RefreshCw size={17} />Uzgodnij rachunki radaru</button><p className="admin-trend-help">Odczytuje rachunki zakończonych zdjęć. System sprawdza je również przed kolejnym dziennym wyszukiwaniem.</p></>}</section>;
  if (budgetOnly) return <div><Link href="/admin/automation" className="admin-breadcrumb"><ArrowLeft size={16} />Codzienne inspiracje</Link><div className="admin-page-heading"><div><h1>Koszty i rachunki radaru</h1><p>Rzeczywiste koszty wyszukiwania i przygotowania przepisów.</p></div></div>{notices}{budgetPanel}</div>;

  return <div className="admin-trends">
    {runId && <Link href="/admin/automation" className="admin-breadcrumb"><ArrowLeft size={16} />Codzienne inspiracje</Link>}
    <div className="admin-page-heading"><div><p className="admin-eyebrow">ŚWIAT GOTUJE. TY WYBIERASZ.</p><h1>{runId ? selectedRun?.selectedTitle?.pl || 'Przebieg radaru' : 'Trendy na Twoim stole.'}</h1><p>{runId ? 'Historia tego uruchomienia, zapisane źródła, koszty i wyniki przygotowania.' : 'Codzienne wyszukiwanie i tekst przepisu. Ty oceniasz szkic, decydujesz o zdjęciach i publikujesz gotowy przepis.'}</p></div><button type="button" className="admin-button is-secondary" onClick={() => void refresh()} disabled={busy || refreshing}><RefreshCw size={16} className={refreshing ? 'admin-spinner' : ''} />Odśwież</button></div>
    {notices}
    <div className="admin-trends-layout"><div className="admin-trends-main">
      <section className="admin-trend-feature">
        <div className="admin-trend-feature-heading"><span className="admin-eyebrow">{selectedRun ? selectedRun.manual ? 'PRZEBIEG RĘCZNY' : selectedRun.mode === 'control' ? 'PRZEBIEG KONTROLNY' : 'DZISIEJSZA INSPIRACJA' : 'TWÓJ CODZIENNY RADAR'}</span>{selectedRun && <span className={'admin-trend-status is-' + selectedRun.status}>{active(selectedRun) && <LoaderCircle size={13} className="admin-spinner" />}{labels[selectedRun.status]}</span>}</div>
        {selectedRun ? <>
          <h2>{selectedRun.selectedTitle?.pl || (selectedRun.status === 'no_candidate' ? 'Starszy przebieg bez wyboru przepisu.' : 'Od inspiracji do gotowego dania.')}</h2>
          <p>{selectedDescription || selected?.automaticSelection?.reason || selected?.rationale || (selectedRun.status === 'no_candidate' ? selectedRun.diagnostics?.outcome ? researchOutcomes[selectedRun.diagnostics.outcome] : 'Ten starszy przebieg nie zawiera szczegółów wyszukiwania. Ponowne sprawdzenie zachowanego wyniku wybierze przepis.' : 'Tutaj pojawi się wybrana potrawa i uzasadnienie jej wyboru.')}</p>
          <div className="admin-trend-facts"><span><Clock3 size={16} />{date(selectedRun.createdAt)}</span><span>{selectedRun.selectionBasis === 'seasonal' ? <><Sprout size={16} />Lokalny bank sezonowy</> : selectedRun.selectionBasis === 'catalog' ? <><Sprout size={16} />Własny katalog</> : <><Globe2 size={16} />{selected?.score.independentSources ?? 0} niezależnych źródeł</>}</span><span>{selectedRun.photos.ready}/{selectedRun.photos.total} fotografii w przepisie</span></div>
          {selectedRun.error && <div className="admin-notice is-error"><AlertCircle size={17} /><span>{safeMessage(selectedRun.error)}</span></div>}
          <div className="admin-actions">
            {!runId && <Link href={'/admin/trends/' + encodeURIComponent(selectedRun.id)} className="admin-button is-secondary">Otwórz ten przepis<ChevronRight size={17} /></Link>}
            {selectedRun.recipeId && <Link href={'/admin/recipes/' + encodeURIComponent(selectedRun.recipeId)} className="admin-button is-secondary">Sprawdź treść i zdecyduj o zdjęciach<ArrowUpRight size={16} /></Link>}
            {canManage && active(selectedRun) && <button type="button" className="admin-button is-secondary" disabled={busy} onClick={() => void runAction({ action: 'pause' })}><Pause size={16} />Wstrzymaj</button>}
            {canManage && selectedRun.status === 'paused' && !detail?.recipe && <button type="button" className="admin-button is-secondary" disabled={busy || (!configuration.search || !configuration.text)} onClick={() => void runAction({ action: 'resume' })}><Play size={16} />Wznów</button>}
            {canManage && ['awaiting_review', 'paused', 'failed', 'uncertain'].includes(selectedRun.status) && <button type="button" className="admin-button is-subtle" disabled={busy} onClick={() => void runAction({ action: 'reject' })}><X size={16} />Odrzuć</button>}
          </div>
          {active(selectedRun) && <p className="admin-trend-recovery-help" role="status">Trwa przygotowanie. Codzienny przebieg kończy się na tekście szkicu; fotografie wymagają osobnej decyzji w edytorze. Panel odświeży postęp.</p>}
        </> : <div className="admin-trend-empty"><Radar size={47} strokeWidth={1.2} /><h2>Jeden przebieg, jeden przepis.</h2><p>Radar szuka potwierdzonego trendu, a jeśli go zabraknie, automatycznie wybiera inspirację z wyszukiwania lub lokalnego banku sezonowego. Po wyczerpaniu nowych pomysłów wraca do istniejącego przepisu z katalogu.</p><ol><li><Search size={18} />Wybór trendu lub inspiracji</li><li><Sprout size={18} />Tekst PL / EN i zamienniki</li><li><CheckCircle2 size={18} />Twoja ocena, decyzja o zdjęciach i ręczna publikacja</li></ol></div>}
      </section>
      {detail?.recipe && selectedRun && <TrendReview key={`${selectedRun.id}:${detail.recipe.revision}`} recipe={detail.recipe} run={selectedRun} />}
      {!runId && <section className="admin-section admin-trend-criteria"><h2>Jak wybieramy jeden przepis?</h2><p>Każde zakończone wyszukiwanie korzysta z tej samej kolejności wyboru.</p><ol><li>Potwierdzony trend: co najmniej trzy niezależne źródła z ostatnich 14 dni, materiał społecznościowy ze zweryfikowanym autorem i aktualny sygnał zainteresowania.</li><li>Inspiracja z wyszukiwania: ciekawa nowa potrawa, która nie spełnia wszystkich kryteriów trendu.</li><li>Inspiracja sezonowa: nowa propozycja z lokalnego banku dopasowana do pory roku, bez przypisywania jej źródeł internetowych.</li><li>Powrót do katalogu: istniejący przepis do ponownego przeglądu, gdy wyczerpano nowe propozycje.</li></ol><p className="admin-subtle">Znacznik „Popularne teraz” otrzymuje wyłącznie potwierdzony trend. Codzienny przebieg opracowuje tekst PL / EN i zapisuje szkic. Każdy wybór wymaga Twojej oceny. Fotografie zlecasz po akceptacji treści, a gotowy przepis publikujesz ręcznie w edytorze.</p></section>}
      {selectedRun && <SearchDiagnostics run={selectedRun} candidates={candidates} />}
      {canManage && selectedRun?.status === 'no_candidate' && <section className="admin-section"><h2>Sprawdź zachowany wynik ponownie.</h2><p>Odczytamy już opłacone wyszukiwanie, ponownie zweryfikujemy źródła i wybierzemy jeden przepis według obecnej kolejności: trend, inspiracja z wyszukiwania, bank sezonowy lub katalog. Koszt opracowania pokażemy po rozliczeniu. Fotografie wymagają później Twojej decyzji w edytorze.</p><button type="button" className="admin-button is-secondary" disabled={busy || hasActive || !configuration.search || data.runs.some(run => run.status === 'uncertain')} onClick={() => void runAction({ action: 'reverify' })}><RefreshCw size={16} />Odczytaj wynik i wybierz przepis</button></section>}
      <section className="admin-section admin-trend-source-section"><div className="admin-trend-section-heading"><div><h2>Zakres monitoringu</h2><p>Dostępne materiały z ostatnich 14 dni. Każda platforma ma własny zakres dostępności.</p></div></div><div className="admin-trend-platforms">{platforms.map(platform => { const state = selectedRun?.sources[platform.id]; return <div key={platform.id}><span>{platform.name}</span><strong>{!state ? 'Jeszcze nie sprawdzono' : state.status === 'available' ? `${state.count} materiałów` : state.status === 'unavailable' ? 'Materiały niedostępne' : 'Brak nowych dowodów'}</strong></div>; })}</div><p className="admin-subtle">Ranking dotyczy zebranego materiału. Liczymy niezależne źródła, świeżość i obecność na różnych platformach.</p></section>
      {selected && <CandidateSources candidate={selected} />}
      {candidates.length > 0 && <section className="admin-section"><h2>Zebrane potrawy</h2><p>{candidates.length} zapisanych propozycji · {candidates.filter(isConfirmedTrend).length} potwierdzonych trendów. Rozwiń potrawę, aby zobaczyć podstawę wyboru, dowody i brakujące potwierdzenia.</p><div className="admin-trend-candidates">{candidates.map(candidate => <details key={candidate.id}><summary><span>{candidate.title.pl}</span><small>{candidateLabel(candidate)}</small></summary><p>{candidate.automaticSelection?.reason || candidate.rationale}</p>{candidate.rejectionReason && <p className="admin-subtle">Kryteria trendu: {candidate.rejectionReason}</p>}<div className="admin-trend-candidate-counts">{candidate.automaticSelection?.basis === 'seasonal' ? <span>Lokalny bank sezonowy</span> : candidate.automaticSelection?.basis === 'catalog' ? <span>Istniejący przepis w katalogu</span> : <><span>{candidate.score.independentSources}/3 niezależnych źródeł trendu</span><span>{candidate.score.platforms} platform</span>{candidate.research && <span>{candidate.research.verifiedSources}/{candidate.research.foundSources} potwierdzonych materiałów</span>}</>}</div><CandidateSources candidate={candidate} compact />{canManage && selectedRun?.manual && selectedRun.status === 'no_candidate' && !candidate.duplicateRecipeId && !candidate.ambiguous && candidate.sources.length > 0 && <div><p className="admin-subtle">Możesz wybrać tę potrawę jako inspirację. Nie otrzyma oznaczenia „Popularne teraz”. Tekst opracujemy bez kolejnego wyszukiwania. O zdjęciach zdecydujesz po jego ocenie.</p><button type="button" className="admin-button is-secondary" disabled={busy || hasActive || (!configuration.search || !configuration.text) || data.runs.some(run => run.status === 'uncertain')} onClick={() => void runAction({ action: 'prepare_inspiration', candidateId: candidate.id })}><Sprout size={16} />Przygotuj tę inspirację</button></div>}</details>)}</div></section>}
      {!runId && <section className="admin-section"><h2>Historia radaru</h2>{data.runs.length ? <div className="admin-trend-history">{data.runs.map(run => <Link href={'/admin/trends/' + encodeURIComponent(run.id)} key={run.id}><span><strong>{run.selectedTitle?.pl || (run.manual ? 'Przebieg ręczny' : run.mode === 'control' ? 'Przebieg kontrolny' : 'Wyszukiwanie trendów')}</strong><small>{date(run.createdAt)} · {run.manual ? 'Ręczny' : run.mode === 'control' ? 'Kontrola' : 'Dzienny radar'}</small></span><span className={'admin-trend-status is-' + run.status}>{labels[run.status]}</span><ChevronRight size={18} /></Link>)}</div> : <p>Pierwszy przebieg pojawi się tutaj po podłączeniu usług.</p>}</section>}
    </div><aside className="admin-trends-rail">{runId ? <section><h2>Codzienne inspiracje</h2><p>Terminy wyszukiwania, szkice do oceny i ustawienia znajdziesz w jednym panelu.</p><Link className="admin-text-link" href="/admin/automation">Otwórz codzienne inspiracje<ArrowUpRight size={14} /></Link></section> : <>
      <section aria-label="Codzienne inspiracje"><p className="admin-eyebrow">CODZIENNE INSPIRACJE</p><h2>Nowy szkic do Twojej oceny.</h2><p>System wyszukuje propozycję i opracowuje tekst PL / EN. Ty sprawdzasz treść, decydujesz o zdjęciach i publikujesz przepis. <Link href="/admin/automation">Terminy i szkice do oceny</Link>.</p><div className="admin-trend-schedule"><Clock3 size={19} /><div><strong>{automationRequested ? (data.settings.autoPauseReason ? 'Wyszukiwanie wstrzymane' : automation.enabled ? 'Codzienne wyszukiwanie włączone' : 'Przygotowanie wymaga uwagi') : 'Codzienne wyszukiwanie wyłączone'}</strong><span>Zdjęcia i publikacja wymagają Twojej decyzji</span></div></div>
        <dl><div><dt>Następne wyszukiwanie</dt><dd>{date(automation.nextSearchAt)}</dd></div><div><dt>Szkice do Twojej oceny</dt><dd>{automation.readyCount}</dd></div></dl>
        <p className="admin-trend-help" role="status">{automation.reason ? safeMessage(automation.reason) : hasActive ? 'Przygotowanie jest w toku. Wynik będzie czekać w szkicach.' : automation.readyCount > 0 ? 'Szkic czeka na Twoją ocenę. Otwórz go przed zleceniem fotografii.' : 'Wynik kolejnego wyszukiwania pojawi się w szkicach do oceny.'}</p>
        {data.settings.autoPauseReason && <><div className="admin-notice" role="status"><Pause size={17} /><div><strong>Codzienne wyszukiwanie jest wstrzymane.</strong><p>{safeMessage(data.settings.autoPauseReason)}</p></div></div>{canManage && <label className="admin-checkbox admin-trend-pause-ack"><input type="checkbox" checked={pauseAcknowledged} disabled={busy} onChange={event => setAcknowledgedAutoPause(event.target.checked ? autoPauseKey : null)} /><span>Sprawdziłem przyczynę zatrzymania i chcę ponownie włączyć codzienne wyszukiwanie.</span></label>}</>}
        {canManage && <button type="button" aria-label={automationRequested ? 'Wyłącz codzienne wyszukiwanie' : 'Włącz codzienne wyszukiwanie'} className={'admin-button ' + (automationRequested ? 'is-secondary' : '')} disabled={busy || (!automationRequested && ((!automation.canEnable) || Boolean(data.settings.autoPauseReason && !pauseAcknowledged)))} onClick={() => void mutate('/api/admin/trends', 'PATCH', { enabled: !automationRequested, acknowledgeAutoPause: !automationRequested && pauseAcknowledged, expectedAutoPauseToken: !automationRequested && pauseAcknowledged ? data.settings.autoPauseToken : undefined }, automationRequested ? 'Codzienne wyszukiwanie zostało wyłączone.' : 'Codzienne wyszukiwanie zostało włączone. Fotografie i publikacja pozostają Twoją decyzją.')}><>{automationRequested ? <Pause size={17} /> : <Play size={17} />}{automationRequested ? 'Wyłącz wyszukiwanie' : 'Włącz wyszukiwanie'}</></button>}
        {data.settings.lastControlAt && <p className="admin-trend-help">Ostatnia udana kontrola: {date(data.settings.lastControlAt)}.</p>}
      </section>
      {budgetPanel}
      <section><h2>Połączenia</h2>{[{ label: 'Wyszukiwanie źródeł', ready: configuration.search }, { label: 'Opracowanie treści', ready: configuration.text }, { label: 'Fotografie', ready: configuration.photos }, { label: 'Biblioteka plików', ready: configuration.storage }, { label: 'Wywołanie harmonogramu', ready: configuration.cron }].map(item => <div className="admin-trend-connection" key={item.label}><span>{item.label}</span><strong className={item.ready ? 'is-ready' : ''}>{item.ready ? <><Check size={13} />Gotowe</> : 'Do konfiguracji'}</strong></div>)}
        <div className="admin-trend-run-buttons">{canManage && <button type="button" className="admin-button" disabled={busy || (!configuration.search || !configuration.text) || Boolean(hasActive) || data.runs.some(run => run.status === 'uncertain')} onClick={() => void startManual()}><Play size={17} />Nowy przebieg ręczny</button>}<button type="button" className="admin-button is-secondary" disabled={busy || (!configuration.search || !configuration.text) || Boolean(hasActive)} onClick={() => void mutate('/api/admin/trends', 'POST', { action: 'control' }, 'Uruchomiono przebieg kontrolny.')}><Radar size={17} />Przebieg kontrolny</button><button type="button" className="admin-button is-subtle" disabled={busy || (!configuration.search || !configuration.text) || !data.settings.enabled || Boolean(hasActive)} onClick={() => void mutate('/api/admin/trends', 'POST', { action: 'run' }, 'Uruchomiono dzisiejszy radar.')}><Search size={17} />Sprawdź dziś</button></div>{canManage && <p className="admin-trend-help">Osobna próba, także tego samego dnia. Jej rzeczywisty koszt pojawi się w zestawieniu radaru.</p>}
      </section>
    </>}</aside></div>
  </div>;
}

function SearchDiagnostics({ run, candidates }: { run: TrendRun; candidates: TrendCandidate[] }) {
  const diagnostics = run.diagnostics;
  const issues = diagnostics ? Object.entries(diagnostics.issueCounts).filter(([, count]) => count > 0) : [];
  return <section className="admin-section admin-trend-diagnostics"><h2>Wynik wyszukiwania</h2>
    {diagnostics?.reverification && <p className="admin-subtle">Ponownie zweryfikowano zachowany wynik: {date(diagnostics.reverification.at)}. Koszt wyszukiwania pozostaje bez zmian.</p>}
    {diagnostics ? <><div className="admin-trend-diagnostic-counts">
      {[['Odnośniki w wynikach', diagnostics.retrievedUrls], ['Znalezione potrawy', diagnostics.discoveredCandidates], ['Materiały do weryfikacji', diagnostics.submittedSources], ['Potwierdzone materiały', diagnostics.verifiedSources], ['Potwierdzone trendy', candidates.filter(isConfirmedTrend).length], ['Wywołania wyszukiwania', diagnostics.toolCalls]].map(([label, count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}
    </div>{diagnostics.outcome && <p>{selectionDescription(run, candidates.find(candidate => candidate.selected || candidate.id === run.candidateId)) || researchOutcomes[diagnostics.outcome]}</p>}
    {diagnostics.discoveryOutcome && <p className="admin-subtle">{discoveryOutcomes[diagnostics.discoveryOutcome]}</p>}
    {issues.length > 0 && <div className="admin-trend-research-gaps"><h3>Co wymagało potwierdzenia?</h3><ul>{issues.map(([reason, count]) => <li key={reason}><span>{researchIssueText(reason)}</span><strong>{count}</strong></li>)}</ul></div>}
    <details className="admin-trend-query-details"><summary>Użyte zapytania ({diagnostics.queries.length})</summary>{diagnostics.queries.length > 0 ? <ol>{diagnostics.queries.map((query, index) => <li key={index}>{query}</li>)}</ol> : <p>Usługa nie udostępniła treści zapytań w tym przebiegu.</p>}</details>
    </> : <p>{run.status === 'queued' || run.status === 'searching' ? 'Szczegóły pojawią się po zakończeniu wyszukiwania.' : 'Ten przebieg nie zawiera zapisanych szczegółów wyszukiwania. Nie odtwarzamy liczby źródeł ani przyczyny pustej listy bez danych.'}</p>}
    <dl className="admin-trend-run-cost"><div><dt>Rozliczony koszt przebiegu</dt><dd>{usd(run.settledUsd ?? run.chargedUsd)}</dd></div><div><dt>Do rozliczenia</dt><dd>{run.pendingCostCount ?? 0} zleceń</dd></div></dl><p className="admin-subtle">Odnośniki, zapytania i dowody są widoczne tylko w panelu. Wynik opisuje zebrany materiał; nie mierzy popularności w całym internecie.</p>
  </section>;
}

function CandidateSources({ candidate, compact = false }: { candidate: TrendCandidate; compact?: boolean }) {
  const basis = candidate.automaticSelection?.basis;
  const sourceExplanation = basis === 'seasonal'
    ? 'Lokalna propozycja sezonowa. Nie przypisujemy jej źródeł ani zainteresowania w internecie.'
    : basis === 'catalog'
      ? 'Istniejący przepis z własnego katalogu. Nie zebrano nowych dowodów jego popularności.'
      : 'Nie ma potwierdzonych, aktualnych materiałów dla tej potrawy.';
  return <section className={compact ? 'admin-trend-source-list is-compact' : 'admin-section admin-trend-source-list'}>
    {!compact && <><h2>Dlaczego właśnie ta potrawa?</h2><p>Źródła i uzasadnienie są dostępne wyłącznie w redakcji.</p></>}
    {!compact && candidate.automaticSelection && <p><strong>{automaticSelectionLabels[candidate.automaticSelection.basis]}.</strong> {candidate.automaticSelection.reason}</p>}
    {candidate.sources.length === 0 && <p className="admin-subtle">{sourceExplanation}</p>}
    <ol>{candidate.sources.map((source, index) => <li key={source.url + index}><div><span>{platforms.find(platform => platform.id === source.platform)?.name}</span><small>{source.publishedAt ? date(source.publishedAt) : 'Brak daty'}</small></div><a className="admin-text-link" href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.publisher}<ArrowUpRight size={15} /></a><p>{source.interestEvidence || source.excerpt}</p><small>{source.publisher}</small></li>)}</ol>
    {Boolean(candidate.research?.issues.length) && <div className="admin-trend-research-gaps"><h3>Brakujące potwierdzenia trendu</h3><ul>{candidate.research!.issues.map((issue, index) => { const href = sourceLink(issue.url); return <li key={issue.url + index}><div><span>{researchIssueText(issue.reason)}</span><small>{platforms.find(platform => platform.id === issue.platform)?.name}</small>{href ? <a className="admin-text-link" href={href} target="_blank" rel="noopener noreferrer">{issue.url}<ArrowUpRight size={13} /></a> : <small className="admin-trend-unverified-url">{issue.url}</small>}</div></li>; })}</ul></div>}
  </section>;
}

function TrendReview({ recipe, run }: { recipe: EditorialRecord; run: TrendRun }) {
  const [locale, setLocale] = useState<Locale>('pl');
  const [viewed, setViewed] = useState<Locale[]>([]);
  const [previewError, setPreviewError] = useState('');
  const complete = recipe.issues.length === 0;
  const publishedCurrentRevision = run.status === 'published' && recipe.publishedRevision === recipe.revision;
  return <section className="admin-section admin-trend-review">
    <div className="admin-trend-section-heading"><div><p className="admin-eyebrow">TWÓJ PRZEGLĄD</p><h2>Sprawdź opracowany szkic.</h2><p>Przeczytaj podglądy PL i EN. W edytorze zaakceptujesz tekst, zdecydujesz o zdjęciach i później ręcznie opublikujesz gotowy przepis.</p></div><Link href={'/admin/recipes/' + encodeURIComponent(recipe.id)} className="admin-button is-secondary">Sprawdź treść i zdecyduj o zdjęciach<ArrowUpRight size={16} /></Link></div>
    <div className="admin-locale-tabs" role="group" aria-label="Język podglądu">{(['pl', 'en'] as const).map(value => <button type="button" key={value} aria-pressed={locale === value} onClick={() => setLocale(value)}>{value === 'pl' ? 'PL' : 'EN · UK'}{viewed.includes(value) && <Check size={13} />}</button>)}</div>
    <iframe key={locale} className="admin-preview-frame" src={`/${locale}/preview/${encodeURIComponent(recipe.id)}?revision=${recipe.revision}`} title={`Podgląd przepisu ${locale.toUpperCase()}`} onLoad={event => {
      let valid = false;
      try {
        const marker = event.currentTarget.contentDocument?.querySelector('[data-preview-recipe]');
        valid = marker?.getAttribute('data-preview-recipe') === recipe.id && marker.getAttribute('data-preview-revision') === String(recipe.revision) && marker.getAttribute('data-preview-locale') === locale;
      } catch { /* An expired session can lead to a different-origin authentication page. */ }
      setPreviewError(valid ? '' : 'Nie udało się wczytać bieżącego podglądu. Odśwież panel i sprawdź sesję.');
      setViewed(current => valid ? current.includes(locale) ? current : [...current, locale] : current.filter(value => value !== locale));
    }} onError={() => {
      setPreviewError('Nie udało się wczytać podglądu. Odśwież panel.');
      setViewed(current => current.filter(value => value !== locale));
    }} />
    {previewError && <p className="admin-notice is-error" role="alert">{previewError}</p>}
    {(recipe.content.recipe.substitutions?.length ?? 0) > 0 && <details className="admin-trend-substitution-review"><summary>Zamienniki do sprawdzenia ({recipe.content.recipe.substitutions!.length})</summary>{recipe.content.recipe.substitutions!.map(item => {
      let quantity: string;
      try { quantity = formatSubstitutionAmount(item, recipe.content.recipe.baseServings, recipe.content.recipe.baseServings, 'metric', locale) || 'Bez ustalonej ilości'; } catch { quantity = 'Ilość wymaga poprawy w edytorze'; }
      return <div key={item.id}><strong>{item.name[locale] || 'Uzupełnij nazwę'}</strong><p>{formatRecipeDurationText(item.note[locale], locale) || 'Uzupełnij wskazówkę'}</p><small>Zamiast: {recipe.content.recipe.ingredients.find(ingredient => ingredient.id === item.ingredientId)?.name[locale] || item.ingredientId}</small><p>{quantity} · {recipe.content.recipe.baseServings} porcji · {item.scaling === 'fixed' ? 'stała ilość' : 'przeliczana wraz z porcjami'} · {item.status === 'approved' ? 'zatwierdzony' : 'do sprawdzenia'}</p></div>;
    })}</details>}
    {!complete && <div className="admin-notice"><AlertCircle size={17} /><div><strong>Szkic wymaga Twojej oceny i uzupełnienia.</strong><p>Brak fotografii jest oczekiwany przed Twoją decyzją. Sprawdź treść w edytorze, zaakceptuj ją i dopiero wtedy zleć zdjęcia.</p><details className="admin-trend-missing"><summary>Elementy przed publikacją ({recipe.issues.length})</summary><ul>{recipe.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></details></div></div>}
    <TrendPhotos recipe={recipe} run={run} />
    <div className="admin-trend-publish"><p>Ocena treści, zlecenie zdjęć i publikacja to osobne, ręczne działania w edytorze. Samo obejrzenie podglądu ich nie uruchamia.</p><Link className="admin-button" href={'/admin/recipes/' + encodeURIComponent(recipe.id)}>Sprawdź treść i zdecyduj o zdjęciach<ArrowUpRight size={16} /></Link></div>
    {publishedCurrentRevision && <div className="admin-trend-publish"><p><CheckCircle2 size={17} />Ten przepis jest opublikowany.</p><Link className="admin-button is-secondary" href={'/pl/recipes/' + encodeURIComponent(recipe.content.recipe.slug.pl)}>Zobacz przepis<ArrowUpRight size={16} /></Link></div>}
  </section>;
}
