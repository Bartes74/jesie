'use client';

import { formatRecipeDuration } from '@/lib/recipe-duration';
import Link from 'next/link';
import { MediaImage } from '@/components/MediaImage';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, ChevronRight, LoaderCircle, Plus, RotateCcw, Search, Sprout, Trash2 } from 'lucide-react';
import { categories } from '@/lib/recipes';
import type { EditorialRecord, RecipeSummary } from '@/lib/editorial-types';
import { DeleteRecipeDialog } from './DeleteRecipeDialog';
import { matchesRecipeFilter, recipeListCounts, recipeListStatus, type RecipeListFilter } from '@/lib/editorial-presentation';

const statusFilters: { id: RecipeListFilter; label: string }[] = [{ id: 'all', label: 'Wszystkie' }, { id: 'draft', label: 'Szkice' }, { id: 'published', label: 'Opublikowane' }, { id: 'archived', label: 'Archiwum' }, { id: 'deleted', label: 'Kosz' }];

function withRecord(summary: RecipeSummary, record: EditorialRecord): RecipeSummary {
  return { ...summary, title: record.content.recipe.title, image: record.content.recipe.image, editorialStatus: record.editorialStatus, publicationStatus: record.publicationStatus, revision: record.revision, publishedRevision: record.publishedRevision, deletedAt: record.deletedAt, updatedAt: record.updatedAt, updatedBy: record.updatedBy, hasUnpublishedChanges: record.publicationStatus !== 'published' || record.revision !== record.publishedRevision };
}

export function RecipeList({ initialRecipes, initialFilter = 'all' }: { initialRecipes: RecipeSummary[]; initialFilter?: RecipeListFilter }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const filter = initialFilter;
  const [overrides, setOverrides] = useState<Record<string, RecipeSummary>>({});
  const [deleteTarget, setDeleteTarget] = useState<RecipeSummary | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mutationBusy = useRef(false);
  const currentRecipes = useMemo(() => initialRecipes.map(recipe => overrides[recipe.id]?.revision >= recipe.revision ? overrides[recipe.id] : recipe), [initialRecipes, overrides]);
  const recipes = useMemo(() => currentRecipes.filter(recipe => {
    const matchesQuery = `${recipe.title.pl} ${recipe.title.en} ${categories.find(category => category.id === recipe.category)?.label.pl || recipe.category}`.toLocaleLowerCase('pl').includes(query.trim().toLocaleLowerCase('pl'));
    const matchesFilter = matchesRecipeFilter(recipe, filter);
    return matchesQuery && matchesFilter;
  }), [currentRecipes, query, filter]);
  const counts = recipeListCounts(currentRecipes);
  const chooseFilter = (next: RecipeListFilter) => { router.replace('/admin/recipes' + (next === 'all' ? '' : '?filter=' + next), { scroll: false }); };

  const mutate = async (target: RecipeSummary, remove: boolean) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true; setBusyId(target.id); setError(''); setNotice(''); setDeleteError('');
    try {
      const endpoint = `/api/admin/recipes/${encodeURIComponent(target.id)}`;
      const response = await fetch(remove ? endpoint : `${endpoint}/actions`, { method: remove ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: target.revision, ...(remove ? {} : { action: 'restore_deleted' }) }) });
      const body = await response.json();
      if (response.status === 409) {
        if (body.latest) {
          const next = withRecord(target, body.latest);
          setOverrides(current => ({ ...current, [target.id]: next }));
          if (remove) { setDeleteTarget(next); setDeleteConflict(true); }
        }
        throw new Error('Przepis zmienił się w międzyczasie. Sprawdź aktualną wersję w edytorze przed ponowieniem operacji.');
      }
      if (!response.ok || !body.recipe) throw new Error(body.error || 'Nie udało się wykonać tej operacji.');
      const next = withRecord(target, body.recipe);
      setOverrides(current => ({ ...current, [target.id]: next }));
      setDeleteTarget(null);
      setNotice(remove ? `Przepis „${target.title.pl || target.title.en || 'Bez tytułu'}” jest w koszu. Możesz go przywrócić w zakładce Kosz.` : `Przepis „${target.title.pl || target.title.en || 'Bez tytułu'}” przywrócono jako szkic. Publikacja wymaga ponownego zatwierdzenia.`);
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nie udało się połączyć z serwisem.';
      if (remove) setDeleteError(message); else setError(message);
    } finally { mutationBusy.current = false; setBusyId(null); }
  };

  return <>
    <div className="admin-page-heading"><div><h1>Przepisy</h1><p>Dodaj pomysł, sprawdź treść i zdjęcia, a potem opublikuj.</p></div><Link className="admin-button" href="/admin/recipes/new"><Plus size={20} />Dodaj przepis</Link></div>
    <div className="admin-stats" aria-label="Stan biblioteki przepisów"><button type="button" className="admin-stat admin-stat-link" onClick={() => chooseFilter('draft')} aria-pressed={filter === 'draft'}><strong>{counts.drafts}</strong><span>Szkice</span></button><button type="button" className="admin-stat admin-stat-link" onClick={() => chooseFilter('published')} aria-pressed={filter === 'published'}><strong>{counts.published}</strong><span>Opublikowane</span></button></div>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    {notice && <div className="admin-notice is-success" role="status"><CheckCircle2 size={18} /><span>{notice}</span></div>}
    <div className="admin-list-toolbar"><label className="admin-search"><Search size={21} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Szukaj przepisu…" aria-label="Szukaj przepisu" /></label><div className="admin-status-tabs" aria-label="Filtruj przepisy">{statusFilters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => chooseFilter(item.id)}>{item.label}</button>)}</div></div>
    {filter === 'deleted' && <p className="admin-trash-help">Przywrócenie przenosi przepis do szkiców. Historia i zdjęcia pozostają przy nim; publikację trzeba zatwierdzić ponownie.</p>}
    {recipes.length ? <table className="admin-table">
      <thead><tr><th scope="col">Przepis</th><th scope="col">Status</th><th scope="col" className="admin-languages">Języki</th><th scope="col" className="admin-table-date">Ostatnia zmiana</th><th scope="col" className="admin-recipe-actions-cell"><span className="sr-only">Działania</span></th></tr></thead>
      <tbody>{recipes.map(recipe => <tr key={recipe.id}>
        <td><Link href={`/admin/recipes/${encodeURIComponent(recipe.id)}`} className="admin-recipe-title">{recipe.image ? <MediaImage src={recipe.image} alt="" width={80} height={64} sizes="80px" maximumWidth={320} className="admin-recipe-thumb" /> : <span className="admin-recipe-thumb" aria-hidden="true"><Sprout size={30} /></span>}<span><strong>{recipe.title.pl || recipe.title.en || 'Bez tytułu'}</strong><small>{categories.find(category => category.id === recipe.category)?.label.pl || recipe.category}{recipe.totalMinutes > 0 && ` · ${formatRecipeDuration(recipe.totalMinutes, 'pl')}`}{!recipe.deletedAt && recipe.hasUnpublishedChanges && recipe.publishedRevision !== null && ' · zmiany w szkicu'}</small></span></Link></td>
        <td className="admin-status-cell"><span className={`admin-tag ${recipe.deletedAt ? 'is-deleted' : recipe.editorialStatus === 'archived' ? 'is-archived' : recipe.publicationStatus === 'published' ? 'is-published' : recipe.editorialStatus !== 'draft' ? 'is-review' : ''}`}>{recipeListStatus(recipe)}</span></td>
        <td className="admin-languages"><span title={recipe.languages.pl ? 'Treść polska uzupełniona' : 'Treść polska wymaga uzupełnienia'}>{recipe.languages.pl ? 'PL' : 'PL —'}</span> · <span title={recipe.languages.en ? 'Treść angielska uzupełniona' : 'Treść angielska wymaga uzupełnienia'}>{recipe.languages.en ? 'EN' : 'EN —'}</span></td>
        <td className="admin-table-date"><time dateTime={recipe.updatedAt} title={`Zmieniono przez: ${recipe.updatedBy}`}>{new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(recipe.updatedAt))}</time></td>
        <td className="admin-recipe-actions-cell"><div className="admin-recipe-actions"><Link href={`/admin/recipes/${encodeURIComponent(recipe.id)}`} className="admin-icon-button admin-open-recipe" aria-label={`${recipe.deletedAt ? 'Otwórz' : 'Edytuj'}: ${recipe.title.pl || recipe.title.en || 'Bez tytułu'}`}><ChevronRight size={19} /></Link>{recipe.deletedAt ? <button type="button" className="admin-icon-button" disabled={!!busyId} aria-label={`Przywróć z kosza: ${recipe.title.pl || recipe.title.en || 'Bez tytułu'}`} title="Przywróć jako szkic" onClick={() => void mutate(recipe, false)}>{busyId === recipe.id ? <LoaderCircle size={18} className="admin-spinner" /> : <RotateCcw size={18} />}</button> : <button type="button" className="admin-icon-button is-danger" disabled={!!busyId} aria-label={`Usuń przepis: ${recipe.title.pl || recipe.title.en || 'Bez tytułu'}`} title="Usuń przepis" onClick={() => { setDeleteError(''); setDeleteConflict(false); setDeleteTarget(recipe); }}><Trash2 size={18} /></button>}</div></td>
      </tr>)}</tbody>
    </table> : <div className="admin-empty"><h2>{query ? 'Nie ma takiego przepisu.' : filter === 'deleted' ? 'Kosz jest pusty.' : 'Tu zaczyna się dobry przepis.'}</h2><p>{query ? 'Zmień frazę lub wybrany filtr.' : filter === 'all' ? 'Dodaj pierwszy szkic i dopracuj go w swoim tempie.' : filter === 'deleted' ? 'Usunięte przepisy znajdziesz tutaj.' : 'W tym widoku nie ma jeszcze przepisów.'}</p>{filter === 'all' && !query && <Link href="/admin/recipes/new" className="admin-button"><Plus size={18} />Dodaj przepis</Link>}</div>}
    <div className="admin-list-footnote"><Sprout size={31} strokeWidth={1.3} /><h3>Od pomysłu do gotowego przepisu.</h3><Link href="/admin/recipes/new" className="admin-text-link">Dodaj własny przepis <ArrowRight size={17} /></Link></div>
    {deleteTarget && <DeleteRecipeDialog title={deleteTarget.title.pl || deleteTarget.title.en} published={deleteTarget.publicationStatus === 'published'} busy={busyId === deleteTarget.id} error={deleteError} conflict={deleteConflict} onConfirm={() => void mutate(deleteTarget, true)} onClose={() => { if (!mutationBusy.current) setDeleteTarget(null); }} />}
  </>;
}
