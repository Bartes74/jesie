'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ExternalLink, ImagePlus, LoaderCircle, RefreshCw, Save, Sparkles, Upload, X } from 'lucide-react';
import type { CollectionRecord } from '@/lib/collections';
import type { GenerationDto, ThemeGenerationPart } from '@/lib/collection-theme-types';
import type { Locale } from '@/lib/recipes';
import { formatCollectionDate } from './CollectionsList';

const statusLabels: Record<GenerationDto['status'], string> = { queued: 'Oczekuje', running: 'Przygotowujemy oprawę', ready: 'Gotowa do oceny', failed: 'Nie udało się przygotować', uncertain: 'Wymaga sprawdzenia wyniku' };
const partLabels: Record<ThemeGenerationPart, string> = { all: 'Cały wygląd', hero: 'Grafika główna', background: 'Tło i oprawa' };

export function CollectionsAppearance({ collection, disabled, onCollection, onConflict }: { collection: CollectionRecord; disabled: boolean; onCollection: (collection: CollectionRecord) => void; onConflict: () => void }) {
  const [brief, setBrief] = useState(collection.content.appearanceBrief);
  const [part, setPart] = useState<ThemeGenerationPart>('all');
  const [inspiration, setInspiration] = useState<string | null>(collection.content.inspirationAssetId);
  const [generations, setGenerations] = useState<GenerationDto[]>([]);
  const [selected, setSelected] = useState<string | null>(collection.content.themeGenerationId);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [reviewedGenerations, setReviewedGenerations] = useState<string[]>([]);
  const mutation = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestKey = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const endpoint = `/api/admin/collections/${encodeURIComponent(collection.id)}`;
  const active = generations.some(item => item.status === 'queued' || item.status === 'running');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    try { const response = await fetch(`${endpoint}/appearance`, { cache: 'no-store', signal }); const body = await response.json(); if (!response.ok || !Array.isArray(body.generations)) throw new Error(body.error || 'Nie udało się wczytać historii opraw.'); if (sequence === refreshSequence.current && !signal?.aborted) { setGenerations(body.generations); setHistoryError(''); } }
    catch (failure) { if (signal?.aborted || sequence !== refreshSequence.current) return; setHistoryError(failure instanceof Error ? failure.message : 'Nie udało się wczytać historii opraw.'); }
  }, [endpoint]);
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => void refresh(controller.signal), 0); return () => { clearTimeout(timer); controller.abort(); }; }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { if (document.visibilityState === 'visible') await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(tick, 5000); };
    timer = setTimeout(tick, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, refresh]);
  useEffect(() => { requestKey.current = null; }, [brief, part, inspiration, collection.revision]);
  async function upload(file: File) {
    if (mutation.current || disabled) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { setError('Wybierz plik JPG, PNG lub WebP o rozmiarze do 10 MB.'); return; }
    mutation.current = true; setBusy('upload'); setError(''); setNotice('');
    try { const form = new FormData(); form.set('file', file); const response = await fetch(`${endpoint}/inspiration`, { method: 'POST', body: form }); const body = await response.json(); if (!response.ok || !body.assetId) throw new Error(body.error || 'Nie udało się zapisać inspiracji.'); setInspiration(body.assetId); setNotice('Inspiracja zapisana. Zostanie użyta podczas następnego generowania.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Nie udało się przesłać zdjęcia.'); }
    finally { mutation.current = false; setBusy(''); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function generate() {
    if (mutation.current || disabled || active || brief.trim().length < 10) return;
    mutation.current = true; setBusy('generate'); setError(''); setNotice('');
    requestKey.current ??= crypto.randomUUID();
    try { const response = await fetch(`${endpoint}/appearance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: collection.revision, brief: brief.trim(), part, inspirationAssetId: inspiration, requestKey: requestKey.current }) }); const body = await response.json(); if (response.status === 409 && (body.code === 'REVISION_CONFLICT' || body.latest)) onConflict(); if (!response.ok || !body.generation) throw new Error(body.error || 'Nie udało się uruchomić generowania.'); setGenerations(current => [body.generation, ...current.filter(item => item.id !== body.generation.id)]); setNotice('Przygotowujemy oprawę. Możesz pozostać na tej stronie lub wrócić później.'); requestKey.current = null; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Nie udało się potwierdzić zlecenia. Ponowienie tego samego opisu sprawdzi to samo zlecenie.'); }
    finally { mutation.current = false; setBusy(''); }
  }
  async function apply(generation: GenerationDto) {
    if (mutation.current || disabled) return;
    mutation.current = true; setBusy(`apply:${generation.id}`); setError(''); setNotice('');
    try { const response = await fetch(`${endpoint}/appearance/${encodeURIComponent(generation.id)}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: collection.revision }) }); const body = await response.json(); if (response.status === 409 && (body.code === 'REVISION_CONFLICT' || body.latest)) onConflict(); if (!response.ok || !body.collection) throw new Error(body.error || 'Nie udało się zastosować oprawy.'); onCollection(body.collection); setSelected(generation.id); setBrief(generation.brief); setInspiration(body.collection.content.inspirationAssetId); setNotice('Oprawa zapisana w szkicu. Opublikuj kolekcję, aby pokazać ją czytelnikom.'); await refresh(); }
    catch (failure) { if (failure instanceof TypeError || failure instanceof SyntaxError) onConflict(); setError(failure instanceof Error ? failure.message : 'Nie udało się potwierdzić zapisu oprawy.'); }
    finally { mutation.current = false; setBusy(''); }
  }
  async function resume(generation: GenerationDto) {
    if (mutation.current || disabled) return;
    mutation.current = true; setBusy(`resume:${generation.id}`); setError('');
    try { const response = await fetch(`${endpoint}/appearance/${encodeURIComponent(generation.id)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: collection.revision }) }); const body = await response.json(); if (response.status === 409 && (body.code === 'REVISION_CONFLICT' || body.latest)) onConflict(); if (!response.ok || !body.generation) throw new Error(body.error || 'Nie udało się sprawdzić zlecenia.'); setGenerations(current => current.map(item => item.id === generation.id ? body.generation : item)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Nie udało się sprawdzić zlecenia.'); }
    finally { mutation.current = false; setBusy(''); }
  }
  async function saveBrief() {
    if (mutation.current || disabled || active) return;
    mutation.current = true; setBusy('save-brief'); setError(''); setNotice('');
    try { const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: collection.revision, content: { ...collection.content, appearanceBrief: brief, inspirationAssetId: inspiration } }) }); const body = await response.json(); if (response.status === 409 && (body.code === 'REVISION_CONFLICT' || body.latest)) onConflict(); if (!response.ok || !body.collection) throw new Error(body.error || 'Nie udało się zapisać opisu.'); onCollection(body.collection); setNotice('Opis oprawy i inspiracja zapisane w szkicu. Możesz wrócić do generowania później.'); }
    catch (failure) { if (failure instanceof TypeError || failure instanceof SyntaxError) onConflict(); setError(failure instanceof Error ? failure.message : 'Nie udało się potwierdzić zapisu opisu.'); }
    finally { mutation.current = false; setBusy(''); }
  }
  const selectedGeneration = generations.find(item => item.id === selected && item.status === 'ready');
  return <section className="admin-section collections-admin-appearance"><p className="admin-eyebrow">OPRAWA KOLEKCJI</p><h2>Opisz klimat. Przygotujemy resztę.</h2><p>Grafika wydarzenia, tło i kolory powstaną z Twojego opisu. Nawigacja i sposób korzystania z jesie.pl pozostają znajome.</p>{disabled && <p className="collections-admin-help">Zapisz zmiany w kolekcji, aby przygotować lub zastosować oprawę dla bieżącej wersji.</p>}
    <fieldset disabled={disabled || !!busy || active} className="collections-admin-fields"><label className="admin-field">Jak ma wyglądać kolekcja?<textarea rows={5} minLength={10} maxLength={8000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Opisz nastrój, światło, materiały, kolory i charakter grafiki. Np. ciepły wieczór przy świątecznym stole, lniany obrus, gałązki świerku i subtelne złote detale…" /><small>Możesz opisać dowolne wydarzenie. Tytuły, opisy i przyciski pozostaną czytelnym tekstem strony.</small></label>
      <label className="admin-field">Co przygotować?<select value={part} onChange={event => setPart(event.target.value as ThemeGenerationPart)}><option value="all">Cały wygląd kolekcji</option><option value="hero" disabled={!collection.content.theme}>Tylko grafikę główną</option><option value="background" disabled={!collection.content.theme}>Tylko tło i kolory</option></select><small>Przy poprawianiu fragmentu zachowamy resztę oprawy zapisanej w szkicu.</small></label>
      <div className="collections-admin-inspiration"><div><h3>Zdjęcie inspiracyjne</h3><p>Opcjonalna wskazówka dla stylu, światła i kompozycji.</p><label className="admin-button is-secondary"><Upload size={16} />{inspiration ? 'Zmień inspirację' : 'Dodaj zdjęcie'}<input className="sr-only" ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></label><small>JPG, PNG lub WebP · do 10 MB</small></div>{inspiration ? <div className="collections-admin-inspiration-image"><Image unoptimized width={150} height={130} src={`${endpoint}/assets/${encodeURIComponent(inspiration)}`} alt="Zdjęcie inspiracyjne do oprawy kolekcji" /><button className="admin-icon-button" type="button" onClick={() => setInspiration(null)} aria-label="Usuń inspirację z kolejnego generowania"><X size={17} /></button></div> : <ImagePlus size={42} strokeWidth={1.1} aria-hidden="true" />}</div>
      <div className="admin-actions"><button className="admin-button" disabled={brief.trim().length < 10} type="button" onClick={() => void generate()}>{busy === 'generate' ? <LoaderCircle size={18} className="admin-spinner" /> : <Sparkles size={18} />}{collection.content.theme ? 'Wygeneruj nową wersję' : 'Wygeneruj wygląd'}</button><button className="admin-button is-secondary" disabled={brief === collection.content.appearanceBrief && inspiration === collection.content.inspirationAssetId} type="button" onClick={() => void saveBrief()}>{busy === 'save-brief' ? <LoaderCircle size={16} className="admin-spinner" /> : <Save size={16} />}Zapisz opis i inspirację</button></div><p className="collections-admin-help">Generowanie korzysta z płatnych usług AI. Zarejestrowane koszty pojawią się przy przygotowanych wersjach. Samo przygotowanie oprawy nie publikuje kolekcji.</p>
    </fieldset>
    {active && <div className="admin-notice" role="status"><LoaderCircle size={20} className="admin-spinner" /><span>Przygotowujemy oprawę. Status odświeża się automatycznie; zlecenie pozostaje w historii po zamknięciu panelu.</span></div>}{error && <div className="admin-notice is-error" role="alert">{error}</div>}{notice && <div className="admin-notice is-success" role="status">{notice}</div>}
    <div className="collections-admin-section-heading"><div><h3>Podgląd</h3><p>{selectedGeneration ? `Wybrana oprawa z ${formatCollectionDate(selectedGeneration.createdAt)}. Jej zastosowanie zapisze ją w szkicu.` : 'Bieżący zapisany szkic kolekcji.'}</p></div>{selectedGeneration && selected !== collection.content.themeGenerationId && <button className="admin-button is-secondary" type="button" onClick={() => setSelected(collection.content.themeGenerationId)}>Pokaż zapisany szkic</button>}</div>
    <CollectionsPreview collectionId={collection.id} revision={collection.revision} generationId={selectedGeneration?.id ?? null} onReady={id => setReviewedGenerations(current => current.includes(id) ? current : [...current, id])} />
    <div className="collections-admin-section-heading"><h3>Historia opraw</h3><button type="button" className="admin-text-link collections-admin-refresh" onClick={() => void refresh()}><RefreshCw size={15} />Odśwież</button></div>{historyError && <p className="admin-inline-error" role="alert">{historyError}</p>}
    <div className="collections-admin-history">{generations.map(generation => <article key={generation.id}><div><h4>{partLabels[generation.part]}</h4><p>{formatCollectionDate(generation.createdAt)} · {statusLabels[generation.status]}{generation.id === collection.content.themeGenerationId ? ' · w bieżącym szkicu' : ''}</p><p className="collections-admin-generation-brief">{generation.brief}</p>{generation.error && <p className="admin-inline-error">{generation.error}</p>}{generation.chargedUsd !== null && <small>Koszt zarejestrowany: {generation.chargedUsd} USD</small>}</div><div className="admin-actions">{generation.status === 'ready' && <><button className="admin-button is-secondary" type="button" aria-pressed={selected === generation.id} onClick={() => setSelected(generation.id)}>Podgląd</button><button className="admin-button" type="button" disabled={disabled || !!busy || generation.id === collection.content.themeGenerationId || !reviewedGenerations.includes(generation.id)} title={!reviewedGenerations.includes(generation.id) ? 'Najpierw otwórz podgląd tej wersji.' : undefined} onClick={() => void apply(generation)}>{busy === `apply:${generation.id}` ? <LoaderCircle size={15} className="admin-spinner" /> : null}Zastosuj do szkicu</button></>}{generation.status === 'failed' && <button className="admin-button is-secondary" type="button" disabled={disabled || !!busy || active} onClick={() => { setBrief(generation.brief); setPart(collection.content.theme ? generation.part : 'all'); setNotice('Przywrócono opis. Sprawdź inspirację i uruchom nową wersję przyciskiem generowania.'); }}>Użyj opisu ponownie</button>}{generation.status === 'uncertain' && <button type="button" className="admin-button is-secondary" disabled={disabled || !!busy || active} onClick={() => void resume(generation)}>{busy === `resume:${generation.id}` ? <LoaderCircle size={15} className="admin-spinner" /> : <RefreshCw size={15} />}Sprawdź i wznów</button>}</div></article>)}</div>{!generations.length && !historyError && <p className="collections-admin-help">Przygotowane wersje oprawy pojawią się tutaj. Wcześniejszą wersję możesz zastosować ponownie bez generowania.</p>}
  </section>;
}

function CollectionsPreview({ collectionId, revision, generationId, onReady }: { collectionId: string; revision: number; generationId: string | null; onReady: (generationId: string) => void }) {
  const [locale, setLocale] = useState<Locale>('pl');
  const [surface, setSurface] = useState<'collection' | 'home'>('collection');
  const [mobile, setMobile] = useState(false);
  const [width, setWidth] = useState(800);
  const [frameState, setFrameState] = useState<{ src: string; status: 'loading' | 'ready' | 'error' }>({ src: '', status: 'loading' });
  const wrapper = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams({ locale, surface, revision: String(revision), ...(generationId ? { generation: generationId } : {}) });
  const src = `/admin/collections/${encodeURIComponent(collectionId)}/preview?${params}`;
  const status = frameState.src === src ? frameState.status : 'loading';
  const frameWidth = mobile ? 390 : 1280;
  const scale = Math.min(1, width / frameWidth);
  useEffect(() => { const element = wrapper.current; if (!element) return; const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width)); observer.observe(element); return () => observer.disconnect(); }, []);
  useEffect(() => { const timer = setTimeout(() => setFrameState(current => current.src === src && current.status === 'ready' ? current : { src, status: 'error' }), 20000); return () => clearTimeout(timer); }, [src]);
  return <><div className="collections-admin-preview-toolbar"><div className="admin-locale-tabs" aria-label="Język podglądu">{(['pl', 'en'] as const).map(value => <button type="button" key={value} aria-pressed={locale === value} onClick={() => setLocale(value)}>{value.toUpperCase()}</button>)}</div><div className="admin-status-tabs" aria-label="Miejsce podglądu"><button type="button" aria-pressed={surface === 'collection'} onClick={() => setSurface('collection')}>Strona kolekcji</button><button type="button" aria-pressed={surface === 'home'} onClick={() => setSurface('home')}>Hero strony głównej</button></div><div className="admin-status-tabs" aria-label="Szerokość podglądu"><button type="button" aria-pressed={!mobile} onClick={() => setMobile(false)}>Komputer</button><button type="button" aria-pressed={mobile} onClick={() => setMobile(true)}>Telefon</button></div><a className="admin-text-link" href={src} target="_blank" rel="noreferrer">Pełny podgląd <ExternalLink size={14} /></a></div>
    {status === 'loading' && <p className="collections-admin-help" role="status">Wczytuję podgląd…</p>}{status === 'error' && <p className="admin-inline-error" role="alert">Nie udało się potwierdzić podglądu. Otwórz pełny podgląd, aby sprawdzić sesję i aktualną wersję.</p>}
    <div ref={wrapper} className="collections-admin-preview-viewport"><div style={{ height: Math.ceil(1000 * scale), width: Math.ceil(frameWidth * scale), marginInline: 'auto' }}><iframe key={src} src={src} title={`Podgląd ${surface === 'home' ? 'hero strony głównej' : 'kolekcji'} · ${locale.toUpperCase()}`} width={frameWidth} height={1000} style={{ width: frameWidth, height: 1000, transform: `scale(${scale})`, transformOrigin: 'top left', border: 0 }} onLoad={event => { try { const valid = Boolean(event.currentTarget.contentDocument?.querySelector('[data-collection-preview]')); setFrameState({ src, status: valid ? 'ready' : 'error' }); if (valid && generationId) onReady(generationId); } catch { setFrameState({ src, status: 'error' }); } }} /></div></div>
  </>;
}
