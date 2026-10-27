'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Check, ExternalLink, LoaderCircle, Save, Search, X } from 'lucide-react';
import { collectionDate, type CollectionContent, type CollectionRecord } from '@/lib/collections';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { categories, type Locale } from '@/lib/recipes';
import { MediaImage } from '@/components/MediaImage';
import { CollectionsAppearance } from './CollectionsAppearance';
import { formatCollectionDate } from './CollectionsList';
import './collections.css';

export type CollectionRecipeOption = Pick<PublicRecipe, 'id' | 'title' | 'image' | 'primaryCategory' | 'times'>;

export function CollectionsEditor({ initialCollection, recipes }: { initialCollection: CollectionRecord; recipes: CollectionRecipeOption[] }) {
  const [record, setRecord] = useState(initialCollection);
  const [content, setContent] = useState<CollectionContent>(initialCollection.content);
  const [locale, setLocale] = useState<Locale>('pl');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const mutation = useRef(false);
  const dirty = JSON.stringify(content) !== JSON.stringify(record.content);
  const update = (patch: Partial<CollectionContent>) => { setContent(current => ({ ...current, ...patch })); setNotice(''); setIssues([]); };
  function accept(next: CollectionRecord) { setRecord(next); setContent(next.content); setIssues([]); setError(''); }
  async function mutate(action: 'save' | 'publish' | 'unpublish') {
    if (mutation.current || needsRefresh) return;
    mutation.current = true; setBusy(action); setError(''); setNotice(''); setIssues([]);
    try {
      const response = await fetch(`/api/admin/collections/${encodeURIComponent(record.id)}${action === 'save' ? '' : '/actions'}`, { method: action === 'save' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: record.revision, ...(action === 'save' ? { content } : { action }) }) });
      const body = await response.json();
      if (response.status === 409 && (body.code === 'REVISION_CONFLICT' || body.latest)) setNeedsRefresh(true);
      if (!response.ok || !body.collection) { if (Array.isArray(body.issues)) setIssues(body.issues); throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się zapisać kolekcji.'); }
      accept(body.collection); setNotice(action === 'save' ? 'Szkic zapisany. Opublikowana wersja pozostaje dostępna do czasu publikacji zmian.' : action === 'publish' ? 'Kolekcja opublikowana. Promocja w hero odbywa się w ustalonym terminie.' : 'Kolekcja wycofana z serwisu. Szkic i oprawa pozostają w panelu.');
    } catch (failure) {
      if (failure instanceof TypeError || failure instanceof SyntaxError) setNeedsRefresh(true);
      setError(failure instanceof Error ? failure.message : 'Nie udało się potwierdzić zapisu.');
    } finally { mutation.current = false; setBusy(''); }
  }
  return <div className="collections-admin-editor">
    <Link className="admin-text-link" href="/admin/collections"><ArrowLeft size={16} />Wszystkie kolekcje</Link>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">KOLEKCJA PRZEPISÓW</p><h1>{record.content.title.pl || record.content.title.en || 'Nowa kolekcja'}</h1><p>{record.publicationStatus === 'published' ? 'Wersja publiczna jest dostępna przez cały rok.' : record.publicationStatus === 'unpublished' ? 'Kolekcja została wycofana.' : 'Przygotuj treść i oprawę przed publikacją.'}</p></div><span className={`admin-tag${record.publicationStatus === 'published' ? ' is-published' : ''}`}>{record.publicationStatus === 'published' ? 'Publiczna' : record.publicationStatus === 'unpublished' ? 'Wycofana' : 'Szkic'}</span></div>
    <div className="collections-admin-save"><span role="status">{dirty ? 'Masz niezapisane zmiany.' : `Zapisano: ${formatCollectionDate(record.updatedAt)}`}</span><button className="admin-button is-secondary" disabled={!dirty || !!busy || needsRefresh} type="button" onClick={() => void mutate('save')}>{busy === 'save' ? <LoaderCircle size={17} className="admin-spinner" /> : <Save size={17} />}Zapisz szkic</button><button className="admin-button" type="button" disabled={dirty || !!busy || needsRefresh || (record.publicationStatus === 'published' && !record.hasUnpublishedChanges)} onClick={() => void mutate('publish')}>{busy === 'publish' ? <LoaderCircle size={17} className="admin-spinner" /> : <Check size={17} />}{record.publicationStatus === 'published' ? 'Opublikuj zmiany' : 'Opublikuj kolekcję'}</button>{record.publicationStatus === 'published' && <button className="admin-button is-subtle" disabled={!!busy || dirty || needsRefresh} type="button" onClick={() => void mutate('unpublish')}>Wycofaj publikację</button>}</div>
    {error && <div className="admin-notice is-error" role="alert">{error}</div>}{notice && <div className="admin-notice is-success" role="status">{notice}</div>}{needsRefresh && <div className="admin-notice">Nie można potwierdzić bieżącej wersji. Skopiuj niezapisane treści przed odświeżeniem. <button className="admin-button is-secondary" type="button" onClick={() => window.location.reload()}>Wczytaj aktualną wersję</button></div>}{issues.length > 0 && <ul className="admin-publish-issues">{issues.map((issue, index) => <li key={`${issue.field}-${index}`}>{issue.message}</li>)}</ul>}
    <fieldset disabled={!!busy || needsRefresh} className="collections-admin-fields">
      <section className="admin-section"><div className="collections-admin-section-heading"><div><h2>Tytuł, opis i adres</h2><p>Uzupełnij oba języki. Adresy opublikowanej kolekcji pozostają stałe.</p></div><div className="admin-locale-tabs" aria-label="Język treści">{(['pl', 'en'] as const).map(value => <button type="button" key={value} aria-pressed={locale === value} onClick={() => setLocale(value)}>{value.toUpperCase()}</button>)}</div></div>
        <label className="admin-field">Tytuł · {locale.toUpperCase()}<input maxLength={160} value={content.title[locale]} onChange={event => update({ title: { ...content.title, [locale]: event.target.value } })} /></label>
        <label className="admin-field">Krótki opis · {locale.toUpperCase()}<textarea rows={3} maxLength={1000} value={content.description[locale]} onChange={event => update({ description: { ...content.description, [locale]: event.target.value } })} /></label>
        <label className="admin-field">Adres · {locale.toUpperCase()}<input value={content.slug[locale]} maxLength={100} disabled={record.firstPublishedAt !== null} onChange={event => update({ slug: { ...content.slug, [locale]: event.target.value } })} /><small>/{locale}/kolekcje/{content.slug[locale] || 'adres-kolekcji'}</small></label>
      </section>
      <CollectionsRecipePicker content={content} recipes={recipes} onChange={update} />
      <CollectionsPromotion content={content} onChange={update} />
    </fieldset>
    <CollectionsAppearance collection={record} disabled={dirty || !!busy || needsRefresh} onCollection={accept} onConflict={() => setNeedsRefresh(true)} />
    {record.publicationStatus === 'published' && <p className="collections-admin-help"><a className="admin-text-link" href={`/pl/kolekcje/${record.content.slug.pl}`} target="_blank" rel="noreferrer">Otwórz opublikowaną kolekcję <ExternalLink size={14} /></a></p>}
  </div>;
}

function CollectionsRecipePicker({ content, recipes, onChange }: { content: CollectionContent; recipes: CollectionRecipeOption[]; onChange: (patch: Partial<CollectionContent>) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [limit, setLimit] = useState(24);
  const byId = useMemo(() => new Map(recipes.map(recipe => [recipe.id, recipe])), [recipes]);
  const visible = useMemo(() => recipes.filter(recipe => (!category || recipe.primaryCategory === category) && `${recipe.title.pl} ${recipe.title.en}`.toLocaleLowerCase('pl').includes(query.trim().toLocaleLowerCase('pl'))), [recipes, category, query]);
  const unavailable = content.recipeIds.filter(id => !byId.has(id));
  function toggle(id: string) { onChange({ recipeIds: content.recipeIds.includes(id) ? content.recipeIds.filter(value => value !== id) : [...content.recipeIds, id] }); }
  function move(index: number, direction: number) { const next = [...content.recipeIds]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange({ recipeIds: next }); }
  return <section className="admin-section"><h2>Przepisy i ich kolejność</h2><p>Wybierasz z całego katalogu opublikowanych przepisów. Kolejność poniżej będzie domyślną kolejnością w kolekcji.</p>
    {content.selectionMode === 'quick-dinners' ? <div className="admin-notice">Ta istniejąca kolekcja automatycznie dobiera obiady do 30 minut na podstawie pełnego czasu i kategorii dania. Pozostałe kolekcje pozwalają wybierać i układać przepisy ręcznie.</div> : <>
      {unavailable.length > 0 && <p className="admin-inline-error">{unavailable.length} przypisanych przepisów jest obecnie niedostępnych publicznie. Nie pojawią się czytelnikom.</p>}
      <ol className="collections-admin-selected">{content.recipeIds.map((id, index) => { const recipe = byId.get(id); const title = recipe?.title.pl || recipe?.title.en || `Niedostępny przepis (${id})`; return <li key={id}><span className="collections-admin-position">{index + 1}</span>{recipe && <MediaImage src={recipe.image} alt="" width={56} height={48} sizes="56px" maximumWidth={320} />}<span className="collections-admin-selected-title">{title}{!recipe && <small>Przepis wycofany lub usunięty</small>}</span><div className="collections-admin-order"><button type="button" className="admin-icon-button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Przenieś wyżej: ${title}`}><ArrowUp size={17} /></button><button type="button" className="admin-icon-button" disabled={index === content.recipeIds.length - 1} onClick={() => move(index, 1)} aria-label={`Przenieś niżej: ${title}`}><ArrowDown size={17} /></button><button type="button" className="admin-icon-button" onClick={() => toggle(id)} aria-label={`Usuń z kolekcji: ${title}`}><X size={17} /></button></div></li>; })}</ol>
      {!content.recipeIds.length && <p className="collections-admin-help">Nie wybrano jeszcze przepisów. Dodaj je z katalogu poniżej.</p>}
      <div className="collections-admin-picker-toolbar"><label className="admin-search"><Search size={18} aria-hidden="true" /><input value={query} type="search" onChange={event => { setQuery(event.target.value); setLimit(24); }} placeholder="Szukaj w opublikowanych przepisach…" aria-label="Szukaj w opublikowanych przepisach" /></label><label className="admin-field"><span className="sr-only">Kategoria przepisów</span><select value={category} onChange={event => { setCategory(event.target.value); setLimit(24); }}><option value="">Wszystkie kategorie</option>{categories.map(item => <option key={item.id} value={item.id}>{item.label.pl}</option>)}</select></label></div>
      <p className="collections-admin-help" role="status">{content.recipeIds.length} wybranych · {visible.length} przepisów w katalogu</p><div className="collections-admin-picker">{visible.slice(0, limit).map(recipe => <label key={recipe.id} className={content.recipeIds.includes(recipe.id) ? 'is-selected' : ''}><input type="checkbox" checked={content.recipeIds.includes(recipe.id)} onChange={() => toggle(recipe.id)} /><MediaImage src={recipe.image} alt="" width={64} height={56} sizes="64px" maximumWidth={320} /><span><strong>{recipe.title.pl || recipe.title.en}</strong><small>{categories.find(item => item.id === recipe.primaryCategory)?.label.pl} · {recipe.times.total} min</small></span></label>)}</div>{visible.length > limit && <button className="admin-button is-secondary" type="button" onClick={() => setLimit(current => current + 24)}>Pokaż kolejne przepisy</button>}{!visible.length && <p className="collections-admin-help">Brak pasujących przepisów. Zmień wyszukiwanie lub kategorię.</p>}
    </>}
    {content.minimumRecipes > 1 && <p className="collections-admin-help">Ta istniejąca kolekcja wymaga co najmniej {content.minimumRecipes} publicznych przepisów.</p>}
  </section>;
}

function CollectionsPromotion({ content, onChange }: { content: CollectionContent; onChange: (patch: Partial<CollectionContent>) => void }) {
  return <section className="admin-section"><h2>Promocja na stronie głównej</h2><p>W wybranym okresie grafika kolekcji zastąpi najnowszy przepis w hero. Po jego zakończeniu kolekcja nadal będzie dostępna w menu, stopce i pod swoim adresem.</p><label className="admin-checkbox"><input type="checkbox" checked={!!content.promotion} onChange={event => onChange({ promotion: event.target.checked ? { from: collectionDate(), to: collectionDate(new Date(Date.now() + 7 * 86400000)) } : null })} /><span>Zaplanuj promocję w hero</span></label>{content.promotion && <><div className="admin-field-grid"><label className="admin-field">Od · włącznie<input type="date" value={content.promotion.from} onChange={event => onChange({ promotion: { ...content.promotion!, from: event.target.value } })} /></label><label className="admin-field">Do · włącznie<input type="date" value={content.promotion.to} min={content.promotion.from} onChange={event => onChange({ promotion: { ...content.promotion!, to: event.target.value } })} /></label></div><p className="collections-admin-help">Pełne dni w strefie Europe/Warsaw. Termin nie może pokrywać się z promocją innej kolekcji.</p></>}</section>;
}
