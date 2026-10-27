'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, LibraryBig, LoaderCircle, Plus, Search } from 'lucide-react';
import type { CollectionRecord } from '@/lib/collections';
import './collections.css';

export function CollectionsList({ collections, recipeId }: { collections: CollectionRecord[]; recipeId?: string }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const visible = useMemo(() => collections.filter(item => (!recipeId || item.content.recipeIds.includes(recipeId) || item.content.selectionMode === 'quick-dinners') && (!query.trim() || `${item.content.title.pl} ${item.content.title.en}`.toLocaleLowerCase('pl').includes(query.trim().toLocaleLowerCase('pl'))) && (status === 'all' || (status === 'published' ? item.publicationStatus === 'published' : item.publicationStatus !== 'published'))), [collections, query, status, recipeId]);
  return <>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">INSPIRACJE NA KAŻDĄ OKAZJĘ</p><h1>Kolekcje</h1><p>Dobierz przepisy, przygotuj oprawę i zaplanuj promocję na stronie głównej.</p></div><Link className="admin-button" href="/admin/collections/new"><Plus size={18} />Dodaj kolekcję</Link></div>
    {recipeId && <div className="admin-notice">Kolekcje przypisane do wybranego przepisu oraz kolekcje automatyczne. <Link className="admin-text-link" href="/admin/collections">Pokaż wszystkie kolekcje</Link></div>}
    <div className="admin-list-toolbar"><label className="admin-search"><Search size={20} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Szukaj kolekcji…" aria-label="Szukaj kolekcji" /></label><div className="admin-status-tabs" aria-label="Status kolekcji">{[['all', 'Wszystkie'], ['published', 'Opublikowane'], ['draft', 'Szkice i wycofane']].map(([value, label]) => <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</button>)}</div></div>
    {visible.length ? <div className="collections-admin-list">{visible.map(item => <Link className="collections-admin-row" key={item.id} href={`/admin/collections/${encodeURIComponent(item.id)}`}><div><h2>{item.content.title.pl || item.content.title.en || 'Bez tytułu'}</h2><p>{item.content.selectionMode === 'quick-dinners' ? 'Automatyczny dobór przepisów' : `${item.content.recipeIds.length} wybranych przepisów`}{item.hasUnpublishedChanges && item.publishedRevision !== null ? ' · zmiany w szkicu' : ''}</p>{item.content.promotion && <small>Promocja: {formatCollectionDate(item.content.promotion.from)} – {formatCollectionDate(item.content.promotion.to)}</small>}</div><span className={`admin-tag${item.publicationStatus === 'published' ? ' is-published' : ''}`}>{item.publicationStatus === 'published' ? 'Publiczna' : item.publicationStatus === 'unpublished' ? 'Wycofana' : 'Szkic'}</span><ArrowRight size={20} aria-hidden="true" /></Link>)}</div> : <div className="admin-empty"><LibraryBig size={35} strokeWidth={1.3} aria-hidden="true" /><h2>{query || status !== 'all' || recipeId ? 'Brak kolekcji w tym widoku.' : 'Każda okazja ma swój smak.'}</h2><p>{query || status !== 'all' || recipeId ? 'Zmień wyszukiwanie lub filtr.' : 'Utwórz kolekcję i połącz wybrane przepisy w opowieść.'}</p><Link className="admin-button" href="/admin/collections/new">Dodaj kolekcję</Link></div>}
    <p className="collections-admin-help">Opublikowane kolekcje są dostępne przez cały rok. Daty określają jedynie promocję w hero strony głównej.</p>
  </>;
}

export function formatCollectionDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', ...(!/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeStyle: 'short' as const } : {}) }).format(date) : '—';
}

export function NewCollectionForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  return <><div className="admin-page-heading"><div><p className="admin-eyebrow">NOWA KOLEKCJA</p><h1>Od pomysłu do wspólnego stołu.</h1><p>Zacznij od nazwy. W kolejnym kroku dodasz przepisy, opis i oprawę.</p></div></div><form className="admin-section collections-admin-create" onSubmit={async event => {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError('');
    try { const response = await fetch('/api/admin/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim() }) }); const body = await response.json(); if (!response.ok || !body.id) throw new Error(body.error || 'Nie udało się utworzyć kolekcji.'); router.push(`/admin/collections/${encodeURIComponent(body.id)}`); router.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Nie udało się połączyć z serwisem.'); submitting.current = false; setBusy(false); }
  }}><label className="admin-field">Nazwa kolekcji po polsku<input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="Np. Boże Narodzenie przy wspólnym stole" /></label>{error && <p className="admin-inline-error" role="alert">{error}</p>}<div className="admin-actions"><button className="admin-button" disabled={busy || !title.trim()} type="submit">{busy ? <LoaderCircle size={18} className="admin-spinner" /> : <Plus size={18} />}Utwórz szkic</button><Link className="admin-text-link" href="/admin/collections">Wróć do kolekcji</Link></div></form></>;
}
