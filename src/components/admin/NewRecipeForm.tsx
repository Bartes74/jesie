'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, AlertCircle, LoaderCircle } from 'lucide-react';

export function NewRecipeForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: React.FormEvent<HTMLFormElement>) {
    const generate = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'manual';
    event.preventDefault(); if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), originalText }) });
      const body = await response.json();
      if (!response.ok || !body.id) throw new Error(body.error || 'Nie udało się utworzyć szkicu. Spróbuj ponownie.');
      router.push(`/admin/recipes/${encodeURIComponent(body.id)}${generate ? '?generate=1' : '?advanced=1'}`); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Nie udało się połączyć z serwisem.'); setBusy(false); }
  }
  return <div className="admin-create-form"><div className="admin-breadcrumb"><Link href="/admin/recipes"><ArrowLeft size={17} />Przepisy</Link><span>/</span><span>Dodaj przepis</span></div><div className="admin-page-heading"><div><h1>Dodaj przepis</h1><p>Podaj sam tytuł, dodaj opis albo wklej pełny przepis. System zrobi research i uzupełni brakujące treści.</p></div></div><form onSubmit={create}><section className="admin-section"><label className="admin-field">Tytuł przepisu<input required maxLength={200} autoFocus value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="Na przykład: zupa, do której wracasz" /></label><label className="admin-field">Opis lub pełny przepis <small>Opcjonalnie. Wpisz pomysł, wskazówki, składniki lub kroki — tyle, ile masz.</small><textarea value={originalText} maxLength={100000} rows={12} disabled={busy} onChange={event => setOriginalText(event.target.value)} placeholder="Tu jest miejsce na Twój przepis…" /></label><div className="admin-notice"><AlertCircle size={17} /><span>Możesz zapisać własny szkic bez generowania albo przygotować treść do sprawdzenia. Zdjęcia wygenerujesz dopiero po jej akceptacji, a publikację zatwierdzisz osobno.</span></div>{error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}</section><div className="admin-actions"><button type="submit" name="mode" value="generate" className="admin-button" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={18} className="admin-spinner" /> : <ArrowRight size={18} />}{busy ? 'Przygotowuję…' : 'Wygeneruj przepis'}</button><button type="submit" name="mode" value="manual" className="admin-button is-secondary" disabled={busy || !title.trim()}>Zapisz szkic bez generowania</button><Link href="/admin/recipes" className="admin-text-link">Wróć do przepisów</Link></div></form></div>;
}
