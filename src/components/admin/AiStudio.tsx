'use client';

import { MediaImage } from '@/components/MediaImage';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, BookOpen, Check, ChefHat, ChevronRight, Circle, ImagePlus, Leaf, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import type { AiBudget, AiConfiguration, AiJob, AiKind, AiStatus, CreateAiJob } from '@/lib/ai-types';
import type { EditorialRecord, RecipeSummary } from '@/lib/editorial-types';
import { PhotoBatchPanel } from '@/components/admin/PhotoBatchPanel';
import { HeroPresentationFields } from '@/components/admin/HeroPresentationFields';
import { heroPresentationIssue, resolveHeroPresentationForBrief, type HeroPresentation } from '@/lib/hero-presentation';

const tasks = [
  { kind: 'recipe', label: 'Treść przepisu', description: 'Pełny przepis po polsku i angielsku.', icon: BookOpen },
  { kind: 'hero', label: 'Zdjęcie dania', description: 'Apetyczny kadr gotowej potrawy.', icon: ImagePlus },
  { kind: 'ingredient', label: 'Składnik', description: 'Fotografia produktu na tle serwisu.', icon: Leaf },
  { kind: 'step', label: 'Krok przygotowania', description: 'Czynność lub konsystencja podczas gotowania.', icon: ChefHat },
] as const;
const suggestedBriefs: Record<AiKind, string> = {
  recipe: 'Dopracuj cały bieżący przepis w języku polskim i angielskim (UK). Zachowaj intencję oraz proporcje z oryginału, sprawdź spójność składników i kroków. Doprecyzuj czasy, właściwą konsystencję i wskazówki, które pomagają rozpoznać, że danie jest gotowe.',
  hero: 'Pokaż gotową potrawę po wszystkich czynnościach przygotowania, zgodnie z wybranym naczyniem i opisem końcowego wyglądu. Zachowaj właściwą konsystencję, miękkie naturalne światło i styl pozostałych zdjęć dań. Całe naczynie i potrawa mają być wycięte razem na przezroczystym tle, z zapasem miejsca wokół brzegów.',
  ingredient: 'Przygotuj studyjną fotografię konkretnego składnika w postaci opisanej w przepisie. Pokaż tylko ten produkt na czystym, jednolitym tle w dokładnym kolorze tła jesie.pl: #FAF8F2 (RGB 250, 248, 242), z miękkim naturalnym cieniem kontaktowym. Zachowaj jego prawdziwy kolor, fakturę i proporcje. Bez dekoracji i innych produktów; proste małe naczynie tylko, gdy jest konieczne dla płynu, proszku lub pasty.',
  step: 'Pokaż najważniejszy moment wybranego kroku: zbliżenie na detal, właściwą konsystencję lub stopień przygotowania. Kadr ma pomagać zrozumieć, po czym poznać prawidłowy efekt. Zachowaj styl zdjęcia głównej potrawy.',
};
const statuses: Record<AiStatus, string> = { queued: 'W kolejce', submitting: 'Wysyłanie', generating: 'Generowanie', ready: 'Do sprawdzenia', failed: 'Błąd', uncertain: 'Wymaga sprawdzenia', cancelled: 'Anulowane', applied: 'W szkicu' };
const active = (status: AiStatus) => status === 'queued' || status === 'submitting' || status === 'generating';
const usd = (value: string) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value));
const when = (value: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const studioMessage = (value: string) => value.replace(/OpenAI(?: API)?/g, 'generator treści').replace(/fal\.ai/g, 'generator zdjęć').replace(/\bAI\b/g, 'generowania');
const errorText = (error: unknown) => error instanceof TypeError ? 'Brak połączenia z serwisem. Odśwież stan przed kolejną operacją.' : error instanceof Error ? studioMessage(error.message) : 'Nie udało się połączyć z serwisem.';

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się wczytać danych.');
  return body;
}

function CostLine({ label, used }: { label: string; used: string }) {
  return <div className="admin-ai-budget-line"><div><span>{label}</span><strong>{usd(used)}</strong></div></div>;
}

export function AiStudio({ initialRecipeId = '' }: { initialRecipeId?: string }) {
  const router = useRouter();
  const [configuration, setConfiguration] = useState<AiConfiguration | null>(null);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [recipeId, setRecipeId] = useState(initialRecipeId);
  const [record, setRecord] = useState<EditorialRecord | null>(null);
  const [heroPresentationDraft, setHeroPresentationDraft] = useState<HeroPresentation | null>(null);
  const [kind, setKind] = useState<AiKind>('recipe');
  const [targetId, setTargetId] = useState('');
  const [imageAction, setImageAction] = useState<CreateAiJob['imageAction']>();
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(true);
  const [recordLoading, setRecordLoading] = useState(Boolean(initialRecipeId));
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState('');
  const [recordError, setRecordError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [filter, setFilter] = useState<'all' | 'active' | 'ready'>('all');
  const busyRef = useRef(false);
  const photoBusyRef = useRef(false);
  const pendingRequest = useRef<CreateAiJob | null>(null);
  const activeJobs = jobs.some(job => active(job.status)) || (configuration?.budget.activeJobs ?? 0) > 0;

  const reload = useCallback(async (signal?: AbortSignal) => {
    const [studio, catalog] = await Promise.all([
      read<{ jobs: AiJob[]; configuration: AiConfiguration }>('/api/admin/ai', signal),
      read<{ recipes: RecipeSummary[] }>('/api/admin/recipes', signal),
    ]);
    setConfiguration(studio.configuration); setJobs(studio.jobs); setRecipes(catalog.recipes);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => reload(controller.signal)).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!recipeId) return;
    const controller = new AbortController();
    void read<{ recipe: EditorialRecord }>('/api/admin/recipes/' + encodeURIComponent(recipeId), controller.signal)
      .then(body => { if (!controller.signal.aborted) { setRecord(body.recipe); setHeroPresentationDraft(null); setRecordError(''); } })
      .catch(err => { if (!controller.signal.aborted) setRecordError(errorText(err)); })
      .finally(() => { if (!controller.signal.aborted) setRecordLoading(false); });
    return () => controller.abort();
  }, [recipeId]);

  useEffect(() => {
    let controller: AbortController | undefined;
    const refreshBudget = () => {
      controller?.abort();
      if (document.hidden || busyRef.current || photoBusyRef.current) return;
      controller = new AbortController();
      const current = controller;
      void read<{ budget: AiBudget }>('/api/admin/ai/budget', current.signal).then(data => {
        if (!current.signal.aborted) setConfiguration(value => value ? { ...value, budget: data.budget } : value);
      }).catch(() => { /* The existing budget remains visible; the server rechecks admission. */ });
    };
    window.addEventListener('focus', refreshBudget);
    document.addEventListener('visibilitychange', refreshBudget);
    return () => { controller?.abort(); window.removeEventListener('focus', refreshBudget); document.removeEventListener('visibilitychange', refreshBudget); };
  }, []);

  useEffect(() => {
    if (!activeJobs) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let disposed = false;
    let generation = 0;
    let delay = 4000;
    const schedule = () => { if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), delay); };
    const poll = async () => {
      const request = ++generation;
      const currentController = new AbortController();
      controller = currentController;
      try {
        const data = await read<{ jobs: AiJob[]; configuration: AiConfiguration }>('/api/admin/ai', currentController.signal);
        if (disposed || request !== generation) return;
        setJobs(data.jobs); setConfiguration(data.configuration); delay = 4000;
      } catch { if (!currentController.signal.aborted) delay = Math.min(delay * 2, 60000); }
      finally { if (request === generation) schedule(); }
    };
    const visibility = () => { ++generation; clearTimeout(timer); controller?.abort(); if (!document.hidden) void poll(); };
    schedule(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [activeJobs]);

  const refresh = async () => {
    if (busyRef.current || photoBusyRef.current) return;
    setRefreshing(true); setError('');
    try { await reload(); } catch (err) { setError(errorText(err)); } finally { setRefreshing(false); }
  };
  const chooseRecipe = (id: string) => {
    if (busyRef.current || photoBusyRef.current) return;
    setImageAction(undefined); setRecipeId(id); setRecord(null); setHeroPresentationDraft(null); setRecordError(''); setRecordLoading(Boolean(id)); setTargetId(''); setConflict(false);
  };
  const refreshRecipe = async () => {
    if (!recipeId || busyRef.current || photoBusyRef.current) return;
    setRecordLoading(true); setRecordError('');
    try {
      const body = await read<{ recipe: EditorialRecord }>('/api/admin/recipes/' + encodeURIComponent(recipeId));
      setRecord(body.recipe); setHeroPresentationDraft(null); setTargetId(''); setConflict(false); setError('');
    } catch (err) { setRecordError(errorText(err)); } finally { setRecordLoading(false); }
  };
  const current = record?.id === recipeId ? record : null;
  const heroPresentation = heroPresentationDraft ?? (current ? resolveHeroPresentationForBrief(current.content.recipe, '') : null);
  const newHero = kind === 'hero' && !imageAction;
  const heroIssue = current ? heroPresentationIssue(current.content.recipe, heroPresentation) : null;
  const localCrop = imageAction === 'crop_step';
  const libraryLookup = kind === 'ingredient';
  const existingPhoto = imageAction === 'remove_background' ? current?.content.recipe.image : localCrop ? current?.content.photos.steps[targetId] : true;
  const ready = configuration && (libraryLookup || (kind === 'recipe' ? configuration.openai : configuration.storage && (localCrop || configuration.fal)));
  const budget = configuration?.budget;
  const concurrencyAvailable = budget && budget.activeJobs < budget.concurrentLimit;
  const needsTarget = kind === 'ingredient' || kind === 'step';
  const canSubmit = Boolean(current && !recordLoading && !recordError && !current.deletedAt && current.editorialStatus !== 'archived' && ready && (libraryLookup || localCrop || concurrencyAvailable) && existingPhoto && (imageAction || brief.trim()) && (!needsTarget || targetId) && (!newHero || !heroIssue) && !conflict);
  const freeze = busy || unconfirmed || photoBusy;
  const filteredJobs = jobs.filter(job => filter === 'all' || (filter === 'active' ? active(job.status) || job.status === 'uncertain' : job.status === 'ready'));

  const saveHeroPresentation = async (): Promise<EditorialRecord> => {
    if (!current) throw new Error('Wybierz przepis.');
    const issue = heroPresentationIssue(current.content.recipe, heroPresentation);
    if (issue || !heroPresentation) throw new Error(issue || 'Uzupełnij wygląd gotowej potrawy.');
    if (!heroPresentationDraft) return current;
    const saved = current.content.recipe.heroPresentation;
    if (saved && saved.container === heroPresentation.container && saved.profileVersion === heroPresentation.profileVersion
      && saved.finalAppearance.pl === heroPresentation.finalAppearance.pl && saved.finalAppearance.en === heroPresentation.finalAppearance.en
      && saved.evidenceStepIds.length === heroPresentation.evidenceStepIds.length && saved.evidenceStepIds.every((id, index) => id === heroPresentation.evidenceStepIds[index])) return current;
    const content = structuredClone(current.content);
    content.recipe.heroPresentation = heroPresentation;
    let response: Response;
    try {
      response = await fetch('/api/admin/recipes/' + encodeURIComponent(current.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: current.revision, content }) });
    } catch {
      setConflict(true);
      throw new Error('Nie udało się potwierdzić zapisu ustawień zdjęcia. Wczytaj aktualną wersję przepisu przed ponownym zleceniem.');
    }
    const body = await response.json().catch(() => {
      setConflict(true);
      throw new Error('Nie udało się potwierdzić zapisu ustawień zdjęcia. Wczytaj aktualną wersję przepisu przed ponownym zleceniem.');
    });
    if (!response.ok || !body.recipe) {
      if (response.status === 409 || response.status >= 500 || response.ok) setConflict(true);
      throw new Error(body.error || 'Nie udało się zapisać ustawień zdjęcia. Wczytaj aktualną wersję przepisu.');
    }
    setRecord(body.recipe);
    return body.recipe;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current || photoBusyRef.current || (!unconfirmed && !canSubmit)) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      if (!pendingRequest.current) {
        if (!current) return;
        const source = newHero ? await saveHeroPresentation() : current;
        pendingRequest.current = { recipeId, expectedRevision: source.revision, kind, ...(needsTarget ? { targetId } : {}), ...(imageAction ? { imageAction } : {}), brief: imageAction === 'remove_background' ? 'Wytnij całe naczynie i potrawę z istniejącego zdjęcia. Zachowaj oryginalne jedzenie i kształt naczynia.' : localCrop ? 'Przytnij istniejące zdjęcie kroku do 21:9 bez rozciągania i ponownego generowania.' : brief.trim(), requestKey: crypto.randomUUID() };
      }
      const response = await fetch('/api/admin/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingRequest.current) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status >= 500 && body.code !== 'PROVIDER_NOT_CONFIGURED') setUnconfirmed(true);
        else { pendingRequest.current = null; setUnconfirmed(false); }
        if (response.status === 409) setConflict(true);
        throw new Error(body.error || 'Nie udało się zlecić generowania.');
      }
      if (!body.job?.id) { setUnconfirmed(true); throw new Error('Nie otrzymaliśmy potwierdzenia zlecenia. Sprawdź to samo zgłoszenie ponownie.'); }
      pendingRequest.current = null; setUnconfirmed(false);
      router.push('/admin/ai/' + encodeURIComponent(body.job.id));
    } catch (err) {
      if (pendingRequest.current) setUnconfirmed(true);
      setError(errorText(err));
    } finally { busyRef.current = false; setBusy(false); }
  };

  const photoBusyChanged = useCallback((value: boolean) => {
    photoBusyRef.current = value; setPhotoBusy(value);
    if (!value) void reload().catch(err => setError(errorText(err)));
  }, [reload]);

  if (loading) return <div className="admin-loading" role="status"><LoaderCircle className="admin-spinner" size={26} /><p>Przygotowuję studio…</p></div>;

  return <div className="admin-ai-studio">
    <div className="admin-page-heading"><div><p className="admin-eyebrow">TWÓJ WARSZTAT KULINARNY</p><h1>Studio</h1><p>Treść, składniki i kulinarne detale. Każdy wynik trafia najpierw do Twojego podglądu.</p></div><button type="button" className="admin-button is-secondary" onClick={() => void refresh()} disabled={refreshing || busy || photoBusy}><RefreshCw size={16} className={refreshing ? 'admin-spinner' : ''} />Odśwież</button></div>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><div><p>{error}</p>{conflict && <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => void refreshRecipe()} disabled={recordLoading}>Wczytaj aktualną wersję przepisu</button>}{unconfirmed && <p>Zgłoszenie mogło dotrzeć do dostawcy. Przycisk poniżej sprawdzi to samo zgłoszenie, zachowując jego identyfikator.</p>}</div></div>}
    {!configuration ? <div className="admin-empty"><h2>Studio czeka na połączenie.</h2><p>Nie udało się odczytać konfiguracji i kosztów. Odśwież dane, aby kontynuować.</p><button type="button" className="admin-button is-secondary" onClick={() => void refresh()} disabled={refreshing}>Wczytaj ponownie</button></div> : <div className="admin-ai-layout">
      <form className="admin-ai-form" onSubmit={event => void submit(event)}>
        <section className="admin-ai-form-section"><div className="admin-ai-section-title"><span>01</span><h2>Wybierz przepis</h2></div>
          <label className="admin-field">Przepis w redakcji<select value={recipeId} onChange={event => chooseRecipe(event.target.value)} disabled={freeze}><option value="">Wybierz przepis…</option>{recipes.filter(item => (!item.deletedAt && item.editorialStatus !== 'archived') || item.id === recipeId).map(item => <option value={item.id} key={item.id}>{item.title.pl || 'Bez tytułu'}{item.deletedAt ? ' · w koszu' : item.editorialStatus === 'archived' ? ' · w archiwum' : ''}</option>)}</select></label>
          {recipes.length === 0 && <p className="admin-subtle admin-ai-help">Zacznij od <Link className="admin-text-link" href="/admin/recipes/new">utworzenia szkicu przepisu</Link>.</p>}
          {recordLoading && <p className="admin-ai-help admin-subtle" role="status"><LoaderCircle size={14} className="admin-spinner" />Wczytywanie treści przepisu…</p>}
          {recordError && <div className="admin-notice is-error" role="alert"><AlertCircle size={16} /><div>{recordError}<button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => void refreshRecipe()}>Wczytaj ponownie</button></div></div>}
          {current && !recordLoading && <div className="admin-ai-selected-recipe">{current.content.recipe.image && <MediaImage src={current.content.recipe.image} alt="" width={76} height={68} sizes="76px" maximumWidth={320} />}<div><strong>{current.content.recipe.title.pl || 'Bez tytułu'}</strong><p>Wersja {current.revision} · {current.content.recipe.ingredients.length} składników · {current.content.recipe.steps.length} kroków</p></div><Link href={'/admin/recipes/' + encodeURIComponent(recipeId)} aria-label="Otwórz przepis w edytorze"><ChevronRight size={20} /></Link></div>}
          {current?.deletedAt && <p className="admin-ai-help">Przepis jest w Koszu. Przywróć go w edytorze, aby kontynuować przygotowanie.</p>}
          {current?.editorialStatus === 'archived' && <p className="admin-ai-help">Przywróć przepis z archiwum w edytorze, aby zlecić generowanie.</p>}
          {current && !current.deletedAt && !recordLoading && !recordError && <details className="admin-hero-settings" open={newHero || !current.content.recipe.image}><summary>Prezentacja zdjęcia głównego</summary><HeroPresentationFields recipe={current.content.recipe} value={heroPresentationDraft ?? undefined} onChange={setHeroPresentationDraft} disabled={freeze || refreshing || current.editorialStatus === 'archived'} /></details>}
          {current && !current.deletedAt && !recordLoading && !recordError && <PhotoBatchPanel key={current.id} record={current} configuration={configuration} disabled={busy || unconfirmed || refreshing || conflict} beforeStart={async mode => mode === 'missing' && !current.content.recipe.image ? saveHeroPresentation() : current} onRecipeUpdated={setRecord} onBusyChange={photoBusyChanged} />}
        </section>
        <section className="admin-ai-form-section"><div className="admin-ai-section-title"><span>02</span><h2>Co tworzymy?</h2></div><fieldset className="admin-ai-task-grid" disabled={freeze}><legend className="sr-only">Rodzaj materiału</legend>{tasks.map(task => <label className={'admin-ai-task' + (kind === task.kind ? ' is-selected' : '')} key={task.kind}><input type="radio" name="ai-kind" value={task.kind} checked={kind === task.kind} onChange={() => { setKind(task.kind); setTargetId(''); setImageAction(undefined); }} /><task.icon size={23} strokeWidth={1.4} /><strong>{task.label}</strong><span>{task.description}</span><Check size={15} className="admin-ai-task-check" aria-hidden="true" /></label>)}</fieldset>
          {needsTarget && <label className="admin-field admin-ai-target">{kind === 'ingredient' ? 'Który składnik?' : 'Który krok?'}<select value={targetId} onChange={event => setTargetId(event.target.value)} disabled={freeze || !current || recordLoading}><option value="">Wybierz {kind === 'ingredient' ? 'składnik' : 'krok'}…</option>{kind === 'ingredient' ? current?.content.recipe.ingredients.map((item, index) => <option key={item.id} value={item.id}>{item.name.pl || 'Składnik ' + (index + 1)}</option>) : current?.content.recipe.steps.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.title.pl || 'Bez tytułu'}</option>)}</select></label>}
          {(kind === 'hero' || kind === 'step') && <label className="admin-field admin-ai-target">Sposób przygotowania zdjęcia<select value={imageAction ?? ''} onChange={event => setImageAction((event.target.value || undefined) as CreateAiJob['imageAction'])} disabled={freeze}><option value="">Nowe zdjęcie</option>{kind === 'hero' ? <option value="remove_background">Usuń tło obecnego zdjęcia</option> : <option value="crop_step">Przytnij obecne zdjęcie do 21:9</option>}</select><small>{imageAction === 'remove_background' ? 'Zachowamy obecną potrawę i całe naczynie, usuwając otoczenie. Wycięcie sprawdzisz przed zapisaniem.' : localCrop ? 'Bezpłatne przycięcie obecnego kadru. Zachowamy jego proporcje i oryginalny detal.' : kind === 'step' ? 'Nowe zdjęcia kroków powstają w proporcjach 21:9.' : 'Nowe zdjęcie pokaże gotową potrawę w wybranym naczyniu, na przezroczystym tle. Ujęcie dopasujemy do naczynia.'}</small>{imageAction && !existingPhoto && <small>Najpierw dodaj zdjęcie do wybranego miejsca w przepisie.</small>}</label>}
          {kind === 'ingredient' && <p className="admin-ai-help">Najpierw sprawdzimy bibliotekę zdjęć. Zgodny składnik w tej samej postaci, na tle w kolorze serwisu z naturalnym cieniem, wykorzystamy bez opłat. Nowa fotografia produktu powstanie tylko, jeśli jej brakuje.</p>}
        </section>
        <section className="admin-ai-form-section"><div className="admin-ai-section-title"><span>03</span><h2>Nadaj kierunek</h2></div><label className="admin-field" htmlFor="ai-brief">Twoje wskazówki<textarea id="ai-brief" value={brief} onChange={event => setBrief(event.target.value)} required={!imageAction} maxLength={2000} rows={5} disabled={freeze || Boolean(imageAction)} placeholder={kind === 'recipe' ? 'Np. zachowaj moje proporcje, dopracuj czasy i opisz, po czym poznać właściwą konsystencję.' : kind === 'step' ? 'Np. zbliżenie na jedwabisty sos oblepiający makaron. Pokaż konsystencję, bez dodatkowych dekoracji.' : 'Np. miękkie światło, naturalna faktura i kadr zgodny ze zdjęciem głównego dania.'} aria-describedby="ai-brief-hint" /><small id="ai-brief-hint" className="admin-ai-brief-hint"><span>Materiał powstanie na podstawie bieżącej treści przepisu i Twoich wskazówek.</span><span>{brief.length}/2000</span></small></label><button type="button" className="admin-text-link admin-ai-inline-button admin-ai-suggestion" onClick={() => setBrief(suggestedBriefs[kind])} disabled={freeze || Boolean(imageAction)}><Sparkles size={14} />Wstaw rekomendowane wskazówki</button></section>
        <div className="admin-ai-submit-zone"><div><span>Koszt materiału</span><p>{localCrop ? 'Bezpłatna korekta istniejącego pliku.' : libraryLookup ? 'Ponowne użycie biblioteki jest bezpłatne. Koszt nowego zdjęcia pokażemy po rozliczeniu.' : 'Rzeczywisty koszt pokażemy przy wyniku, po potwierdzeniu rozliczenia.'}</p></div><button type="submit" className="admin-button" disabled={busy || photoBusy || (!unconfirmed && !canSubmit)}>{busy ? <LoaderCircle size={18} className="admin-spinner" /> : <Sparkles size={18} />}{unconfirmed ? 'Sprawdź zgłoszenie' : localCrop ? 'Przytnij zdjęcie' : imageAction === 'remove_background' ? 'Wytnij danie' : libraryLookup ? 'Przygotuj zdjęcie składnika' : 'Generuj materiał'}<ArrowRight size={17} /></button></div>
        {!ready && <div className="admin-notice"><AlertCircle size={17} /><span>{kind === 'recipe' ? 'Generator treści czeka na konfigurację.' : localCrop ? 'Korekta zdjęcia czeka na skonfigurowanie magazynu plików.' : !configuration.fal ? 'Generator zdjęć czeka na konfigurację.' : 'Generowanie zdjęć czeka na skonfigurowanie magazynu plików.'}</span></div>}

        {ready && !concurrencyAvailable && !localCrop && !libraryLookup && <div className="admin-notice"><LoaderCircle size={17} /><span>Wszystkie miejsca generowania są zajęte. Poczekaj, aż zakończy się jedno z zadań.</span></div>}
      </form>
      <aside className="admin-ai-rail"><section className="admin-ai-budget"><p className="admin-eyebrow">KOSZTY GENEROWANIA</p><h2>Rzeczywiste zużycie.</h2><p>Potwierdzone rozliczenia za treści i fotografie.</p><CostLine label="Dzisiaj (UTC)" used={configuration.budget.dailyUsedUsd} /><CostLine label="W tym miesiącu (UTC)" used={configuration.budget.monthlyUsedUsd} /><CostLine label="Od początku" used={configuration.budget.pilotUsedUsd} /><div className="admin-ai-budget-foot"><div><span>Do rozliczenia</span><strong>{configuration.budget.pendingCostCount ?? 0} zleceń</strong></div><div><span>Zadania w toku</span><strong>{configuration.budget.activeJobs} / {configuration.budget.concurrentLimit}</strong></div></div><Link href="/admin/settings#budget-settings-heading" className="admin-ai-budget-settings-link">Koszty i rachunki<ChevronRight size={14} /></Link></section>
        <section className="admin-ai-connections"><h3>Połączenia</h3>{[{ label: 'Generator treści', ready: configuration.openai }, { label: 'Generator zdjęć', ready: configuration.fal }, { label: 'Magazyn zdjęć', ready: configuration.storage }].map(item => <div key={item.label}><span>{item.label}</span><span className={item.ready ? 'is-ready' : ''}>{item.ready ? <Check size={13} /> : <Circle size={10} />}{item.ready ? 'Gotowe' : 'Do konfiguracji'}</span></div>)}<Link href="/admin/settings" className="admin-text-link">Ustawienia panelu<ChevronRight size={14} /></Link></section>
        <section className="admin-ai-workflow-note"><Sparkles size={23} strokeWidth={1.3} /><h3>Najpierw sprawdź.</h3><p>Przejrzysz obie wersje językowe lub gotowe zdjęcie. Wynik zastosujesz osobno do szkicu, a publikacją zajmiesz się w edytorze.</p></section>
      </aside>
    </div>}
    <section className="admin-ai-history"><div className="admin-ai-history-heading"><div><h2>Twoje generowania</h2><p>Do każdego wyniku możesz wrócić, także po zamknięciu tej strony.</p></div><div className="admin-status-tabs" aria-label="Filtr zadań">{[{ id: 'all', label: 'Wszystkie' }, { id: 'active', label: 'W toku' }, { id: 'ready', label: 'Do sprawdzenia' }].map(item => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id as typeof filter)}>{item.label}</button>)}</div></div>
      {filteredJobs.length === 0 ? <div className="admin-ai-empty"><Sparkles size={28} strokeWidth={1.2} /><h3>{jobs.length === 0 ? 'Pierwszy pomysł czeka.' : 'Nie ma zadań w tym widoku.'}</h3><p>{jobs.length === 0 ? 'Wybierz przepis i materiał powyżej. Tutaj pojawią się status, wynik i rozliczenie.' : 'Zmień filtr, aby zobaczyć pozostałe generowania.'}</p></div> : <div className="admin-ai-job-list">{filteredJobs.map(job => { const task = tasks.find(item => item.kind === job.kind)!; return <Link href={'/admin/ai/' + encodeURIComponent(job.id)} className="admin-ai-job-row" key={job.id}><span className="admin-ai-job-icon"><task.icon size={22} strokeWidth={1.5} /></span><div className="admin-ai-job-title"><strong>{job.recipeTitle || 'Bez tytułu'}</strong><span>{task.label} · {when(job.createdAt)}</span></div><span className={'admin-ai-status is-' + job.status}>{active(job.status) && <LoaderCircle size={13} className="admin-spinner" />}{statuses[job.status]}</span><div className="admin-ai-job-cost"><strong>{job.costBasis === 'usage' && job.chargedUsd !== null ? usd(job.chargedUsd) : 'Do rozliczenia'}</strong><span>{job.costBasis === 'usage' && job.chargedUsd !== null ? 'potwierdzono' : 'koszt niepotwierdzony'}</span></div><ChevronRight size={17} className="admin-ai-job-arrow" /></Link>; })}</div>}
    </section>
  </div>;
}
