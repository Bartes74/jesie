'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { LibraryImage, LibraryTarget } from '@/lib/media-library';
import { RecipePhoto } from '@/components/RecipePhoto';

export function MediaLibrary({ images, target, revision }: { images: LibraryImage[]; target?: LibraryTarget; revision?: number }) {
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('');
  const [compatibleOnly, setCompatibleOnly] = useState(Boolean(target)); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const busyRef = useRef(false);
  const visible = useMemo(() => images.filter(item => (!kind || item.kind === kind) && (!compatibleOnly || item.compatible) && [item.title, item.product, item.form, ...item.uses.map(use => use.title)].join(' ').toLocaleLowerCase('pl').includes(query.toLocaleLowerCase('pl'))), [images, query, kind, compatibleOnly]);
  async function reuse(imageId: string) {
    if (!target || !revision || busyRef.current || done || needsRefresh) return;
    busyRef.current = true;
    setBusy(imageId); setError('');
    try {
      const result = await fetch('/api/admin/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...target, expectedRevision: revision, imageId }) });
      const body = await result.json();
      if (result.status === 409 || result.status >= 500) setNeedsRefresh(true);
      if (!result.ok) throw new Error(result.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się zapisać zdjęcia.');
      if (!body.recipe?.id || body.recipe.id !== target.recipeId || body.recipe.revision < revision) { setNeedsRefresh(true); throw new Error('Nie otrzymaliśmy potwierdzenia zapisu. Wczytaj aktualną wersję przepisu.'); }
      setDone(true);
    } catch (failure) {
      if (failure instanceof TypeError || failure instanceof SyntaxError) setNeedsRefresh(true);
      setError(failure instanceof Error ? failure.message : 'Nie udało się potwierdzić zapisu.');
    } finally { busyRef.current = false; setBusy(''); }
  }
  return <><div className="admin-notice">Biblioteka zawiera zapisane fotografie i zgodne zdjęcia startowe. Ponowne użycie nie zleca generowania i nie publikuje szkicu.</div>{target && <p>Wybierasz zdjęcie do przepisu. Zgodność składnika obejmuje produkt, jego postać i styl. Zdjęcia potrawy i kroków pozostają przypisane do właściwego przepisu. <Link href={`/admin/recipes/${encodeURIComponent(target.recipeId)}`}>Wróć do przepisu</Link></p>}<div className="admin-library-filters"><label>Szukaj produktu lub przepisu<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Rodzaj<select value={kind} onChange={event => setKind(event.target.value)}><option value="">Wszystkie</option><option value="hero">Dania</option><option value="ingredient">Składniki</option><option value="step">Kroki</option></select></label>{target && <label><input type="checkbox" checked={compatibleOnly} onChange={event => setCompatibleOnly(event.target.checked)} />Tylko pasujące do wybranego miejsca</label>}</div><p role="status">{visible.length} zdjęć{done ? ' · Zdjęcie zapisane w szkicu.' : ''}</p>{error && <p role="alert">{error}</p>}{needsRefresh && <p>Wczytaj aktualny przepis przed kolejnym zapisem. <button className="admin-button is-secondary" type="button" onClick={() => window.location.reload()}>Odśwież bibliotekę</button></p>}{done && target && <Link className="admin-button" href={`/admin/recipes/${encodeURIComponent(target.recipeId)}`}>Sprawdź zapisane zdjęcie</Link>}<div className="admin-library-grid">{visible.map(item => <article key={item.id} className="admin-library-item"><RecipePhoto media={item.photo} locale="pl" sizes="320px" /><h3>{item.title}</h3>{item.product && <p>{item.product} · {item.form}</p>}<details><summary>Pochodzenie i wykorzystanie</summary><p>{item.id.startsWith('static:') ? 'Biblioteka startowa' : `Zapisane ${new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' }).format(new Date(item.createdAt))}`}</p><p>Profil: {item.profile}</p>{item.sourceRecipeId && <p><Link href={`/admin/recipes/${encodeURIComponent(item.sourceRecipeId)}`}>Przepis źródłowy</Link></p>}{item.uses.length ? <ul>{item.uses.map(use => <li key={use.id}><Link href={`/admin/recipes/${encodeURIComponent(use.id)}`}>{use.title}</Link></li>)}</ul> : <p>Brak wykorzystania w bieżących szkicach.</p>}</details>{target && <button type="button" className="admin-button is-secondary" disabled={!item.compatible || Boolean(busy) || done || needsRefresh} onClick={() => void reuse(item.id)}>{busy === item.id ? 'Zapisuję…' : item.compatible ? 'Użyj w tym miejscu' : 'Inna treść, produkt, styl lub przeznaczenie'}</button>}</article>)}</div>{!visible.length && <p>Nie znaleziono zgodnych zdjęć. Zmień wyszukiwanie lub wróć do przepisu i przygotuj brakujące zdjęcie.</p>}</>;
}
