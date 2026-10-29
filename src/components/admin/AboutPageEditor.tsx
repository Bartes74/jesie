'use client';

import { useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, RotateCcw, Save } from 'lucide-react';
import { defaultAboutPage, type AboutPageContent, type AboutPageRecord } from '@/lib/about-page';
import type { Locale } from '@/lib/recipes';
import { formatCollectionDate } from './CollectionsList';
import './collections.css';

type Field = keyof AboutPageContent['pl'];

export function AboutPageEditor({ initialPage }: { initialPage: AboutPageRecord | null }) {
  const [record, setRecord] = useState(initialPage);
  const saved = record?.content ?? defaultAboutPage;
  const [content, setContent] = useState<AboutPageContent>(saved);
  const [locale, setLocale] = useState<Locale>('pl');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const mutation = useRef(false);
  const dirty = JSON.stringify(content) !== JSON.stringify(saved);
  const update = (field: Field, value: string) => { setContent(current => ({ ...current, [locale]: { ...current[locale], [field]: value } })); setNotice(''); setIssues([]); };
  async function save() {
    if (mutation.current || needsRefresh) return;
    mutation.current = true; setBusy(true); setError(''); setNotice(''); setIssues([]);
    try {
      const response = await fetch('/api/admin/site-pages/about', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: record?.revision ?? 0, content }) });
      const body = await response.json();
      if (response.status === 409) setNeedsRefresh(true);
      if (!response.ok || !body.page) { if (Array.isArray(body.issues)) setIssues(body.issues); throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się zapisać strony.'); }
      setRecord(body.page); setContent(body.page.content); setNotice('Zapisano. Nowa treść jest już widoczna w serwisie.');
    } catch (failure) {
      if (failure instanceof TypeError || failure instanceof SyntaxError) setNeedsRefresh(true);
      setError(failure instanceof Error ? failure.message : 'Nie udało się potwierdzić zapisu.');
    } finally { mutation.current = false; setBusy(false); }
  }
  const text = content[locale];
  // Inputs enforce maximum lengths, so a rejected field is in practice an empty required one.
  const field = (name: Field) => issues.some(item => item.field === `${locale}.${name}`) && <small role="alert">Uzupełnij to pole.</small>;
  const otherLocale = locale === 'pl' ? 'en' : 'pl';
  return <div className="collections-admin-editor">
    <div className="admin-page-heading"><div><p className="admin-eyebrow">STRONA SERWISU</p><h1>O serwisie</h1><p>Treść strony /pl/o-serwisie i /en/o-serwisie. Zapis od razu zmienia stronę publiczną.</p></div></div>
    <div className="collections-admin-save"><span role="status">{dirty ? 'Masz niezapisane zmiany.' : record ? `Zapisano: ${formatCollectionDate(record.updatedAt)} · ${record.updatedByName}` : 'Serwis pokazuje wbudowaną treść.'}</span>
      <button className="admin-button is-secondary" disabled={busy || needsRefresh} type="button" onClick={() => { setContent(current => ({ ...current, [locale]: defaultAboutPage[locale] })); setNotice(''); }}><RotateCcw size={17} />Wstaw tekst domyślny · {locale.toUpperCase()}</button>
      <button className="admin-button" disabled={!dirty || busy || needsRefresh} type="button" onClick={() => void save()}>{busy ? <LoaderCircle size={17} className="admin-spinner" /> : <Save size={17} />}Zapisz</button></div>
    {error && <div className="admin-notice is-error" role="alert">{error}{issues.some(item => item.field.startsWith(`${otherLocale}.`)) && ` Popraw też wersję ${otherLocale.toUpperCase()}.`}</div>}{notice && <div className="admin-notice is-success" role="status">{notice}</div>}{needsRefresh && <div className="admin-notice">Nie można potwierdzić bieżącej wersji. Skopiuj niezapisane treści przed odświeżeniem. <button className="admin-button is-secondary" type="button" onClick={() => window.location.reload()}>Wczytaj bieżącą wersję</button></div>}
    <fieldset disabled={busy || needsRefresh} className="collections-admin-fields">
      <section className="admin-section"><div className="collections-admin-section-heading"><div><h2>Treść strony</h2><p>Uzupełnij oba języki. Nagłówek sekcji zacznij od „## ”, akapity oddziel pustą linią.</p></div><div className="admin-locale-tabs" aria-label="Język treści">{(['pl', 'en'] as const).map(value => <button type="button" key={value} aria-pressed={locale === value} onClick={() => setLocale(value)}>{value === 'pl' ? 'Polski' : 'English (UK)'}</button>)}</div></div>
        <label className="admin-field">Tytuł strony · {locale.toUpperCase()}<input maxLength={200} value={text.heading} onChange={event => update('heading', event.target.value)} />{field('heading')}</label>
        <label className="admin-field">Wstęp · {locale.toUpperCase()}<textarea rows={2} maxLength={500} value={text.lead} onChange={event => update('lead', event.target.value)} />{field('lead')}</label>
        <label className="admin-field">Treść · {locale.toUpperCase()}<textarea rows={18} maxLength={20000} value={text.body} onChange={event => update('body', event.target.value)} />{field('body')}</label>
        <label className="admin-field">Opis dla wyszukiwarek · {locale.toUpperCase()}<textarea rows={2} maxLength={300} value={text.description} onChange={event => update('description', event.target.value)} /><small>{text.description.length}/300 · meta description i podgląd linku</small>{field('description')}</label>
      </section>
    </fieldset>
    <p className="collections-admin-help"><a className="admin-text-link" href={`/${locale}/o-serwisie`} target="_blank" rel="noreferrer">Otwórz stronę · {locale.toUpperCase()} <ExternalLink size={14} /></a></p>
  </div>;
}
