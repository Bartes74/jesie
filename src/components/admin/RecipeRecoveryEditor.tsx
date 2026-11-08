'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, LoaderCircle, RefreshCw } from 'lucide-react';
import { recipeDiets, type RecipeDietId } from '@/lib/recipe-diet';
import './recipe-recovery-editor.css';

type View = {
  recipeId: string; expectedRevision: number; version: number; proposal: Record<string, unknown>; canEdit: boolean;
  reviewedIngredients: { ingredientId: string; diet: RecipeDietId }[]; reason: string; evidenceUrls: string[];
  issues: { field: string; message: string }[];
  pendingReceipt?: boolean;
};
type Ingredient = { id: string; name: { pl: string; en: string } };

function ingredientsIn(raw: string): Ingredient[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value.ingredients) ? value.ingredients.filter((item: Ingredient) => item && typeof item.id === 'string'
      && typeof item.name?.pl === 'string' && typeof item.name?.en === 'string') : [];
  } catch { return []; }
}

export function RecipeRecoveryEditor({ jobId }: { jobId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [proposal, setProposal] = useState('');
  const [reviews, setReviews] = useState<Record<string, RecipeDietId | ''>>({});
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const endpoint = `/api/admin/ai/${encodeURIComponent(jobId)}/recipe-repair`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { cache: 'no-store', signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Nie udało się wczytać punktu wznowienia.');
    if (signal?.aborted) return;
    setView(data); setProposal(JSON.stringify(data.proposal, null, 2)); setReason(data.reason);
    setIssues(data.issues ?? []);
    setReviews(Object.fromEntries(data.reviewedIngredients.map((item: { ingredientId: string; diet: RecipeDietId }) => [item.ingredientId, item.diet])));
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal)).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Nie udało się wczytać wyniku.'); });
    return () => controller.abort();
  }, [load]);

  const save = async () => {
    if (!view || busy) return;
    setBusy(true); setError(''); setIssues([]); setNotice('');
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(proposal); } catch { throw new Error('Treść musi być poprawnym obiektem JSON. Sprawdź przecinki i cudzysłowy.'); }
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        expectedRevision: view.expectedRevision, expectedVersion: view.version, proposal: parsed, reason,
        reviewedIngredients: Object.entries(reviews).filter(([, diet]) => diet).map(([ingredientId, diet]) => ({ ingredientId, diet })),
      }) });
      const data = await response.json();
      if (!response.ok) { setIssues(data.issues ?? []); throw new Error(data.error || 'Nie udało się zapisać korekty.'); }
      setView({ ...view, version: data.version, canEdit: Boolean(data.recoveryPending) });
      setNotice(data.message || 'Korekta jest zapisana. Wznowiono sprawdzanie tego samego wyniku. Wróć do przepisu, aby przeczytać gotową treść.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Nie udało się zapisać korekty.'); }
    finally { setBusy(false); }
  };

  const attachReceipt = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/admin/ai/${encodeURIComponent(jobId)}/receipt`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: requestId.trim(), reason }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Nie potwierdzono powiązania zgłoszenia.');
      setNotice(data.message || 'Potwierdzenie zostało zweryfikowane i zapisane. Wznowiono odczyt tego samego zlecenia. Wróć do przepisu, aby sprawdzić wynik.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Nie udało się sprawdzić potwierdzenia.'); }
    finally { setBusy(false); }
  };

  const ingredients = ingredientsIn(proposal);
  return <div className="recipe-recovery-editor">
    <Link href={`/admin/ai/${encodeURIComponent(jobId)}`} className="admin-text-link"><ArrowLeft size={16} />Wróć do zadania</Link>
    <header className="admin-page-heading"><div><p className="admin-eyebrow">WZNAWIANIE PRZEPISU</p><h1>Dokończ zachowany wynik</h1><p>Popraw krok, który zatrzymał sprawdzanie. Research, oryginalna odpowiedź i historia kosztów są zachowane. Zapis uruchamia wyłącznie ponowną walidację tej treści.</p></div></header>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><div><p>{error}</p>{issues.length > 0 && <ul>{issues.map((issue, index) => <li key={index}><strong>{issue.field}:</strong> {issue.message}</li>)}</ul>}<button className="admin-text-link" disabled={busy} onClick={() => { setError(''); void load().catch(err => setError(err instanceof Error ? err.message : 'Nie udało się odświeżyć.')); }}><RefreshCw size={15} />Wczytaj zapisaną wersję</button></div></div>}
    {notice && <div className="admin-notice" role="status"><p>{notice}</p></div>}
    {!error && issues.length > 0 && <section className="recipe-recovery-issues"><h2>Przyczyna zatrzymania</h2><ul>{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></section>}
    {!view && !error && <p role="status"><LoaderCircle className="admin-spinner" size={18} />Wczytuję zachowaną odpowiedź…</p>}
    {view?.pendingReceipt && <section className="admin-editor-section"><h2>Ustal, czy generator przyjął zgłoszenie</h2><p>Jeżeli połączenie zerwało się przy wysyłaniu, sprawdź zgłoszenie w panelu dostawcy i podaj jego identyfikator. Odczytamy istniejące potwierdzenie i sprawdzimy, czy dostawca przypisał je dokładnie do tego zadania. Nie wysyłamy nowego generowania.</p>
      {!notice && <form onSubmit={event => { event.preventDefault(); void attachReceipt(); }}><fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <label className="admin-field">Identyfikator odpowiedzi generatora<input required value={requestId} onChange={event => setRequestId(event.target.value)} placeholder="resp_…" maxLength={495} /></label>
        <label className="admin-field">Jak potwierdzono zgłoszenie?<textarea required rows={3} minLength={10} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <button type="submit" className="admin-button" disabled={busy || !requestId.trim() || reason.trim().length < 10}>{busy && <LoaderCircle size={16} className="admin-spinner" />}Sprawdź potwierdzenie i wznów odczyt</button>
      </fieldset></form>}
      <Link className="admin-text-link" href={`/admin/recipes/${encodeURIComponent(view.recipeId)}`}>Wróć do przepisu</Link>
    </section>}
    {view && !view.pendingReceipt && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || !view.canEdit} style={{ border: 0, padding: 0 }}>
        <section className="admin-editor-section"><h2>Sprawdź nierozpoznane składniki</h2><p>Jeżeli blokadą jest słownik lub skład produktu, sprawdź dokładną nazwę i skład. Wybierz kategorię tylko przy składniku, którego tożsamość potwierdzasz. Decyzja dotyczy tej nazwy w tym przepisie i zostanie zapisana z Twoim podpisem.</p>
          <div className="recipe-recovery-ingredients">{ingredients.map(item => <label className="admin-field" key={item.id}>{item.name.pl} · {item.name.en}<select value={reviews[item.id] ?? ''} onChange={event => setReviews({ ...reviews, [item.id]: event.target.value as RecipeDietId | '' })}><option value="">Bez ręcznego rozstrzygnięcia</option>{recipeDiets.map(diet => <option value={diet.id} key={diet.id}>{diet.label.pl}</option>)}</select></label>)}</div>
        </section>
        <details className="admin-editor-section"><summary>Popraw pozostałe pola zachowanego przepisu</summary><p>Edytuj tylko pola wskazane w błędzie. Obie wersje językowe i identyfikatory składników oraz kroków muszą pozostać spójne. System ponownie sprawdzi kompletność, czasy, skład, źródła i zasady treści.</p><label className="admin-field">Treść przepisu (JSON)<textarea rows={24} spellCheck={false} value={proposal} onChange={event => setProposal(event.target.value)} style={{ fontFamily: 'monospace', width: '100%' }} /></label></details>
        {view.evidenceUrls.length > 0 && <details className="admin-editor-section"><summary>Źródła zachowane w researchu</summary><ul>{view.evidenceUrls.map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></li>)}</ul></details>}
        <label className="admin-field">Co sprawdzono lub poprawiono?<textarea required minLength={10} maxLength={2000} rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Opisz ustalony skład produktu albo poprawione pola." /></label>
        <button type="submit" className="admin-button" disabled={busy || reason.trim().length < 10}>{busy ? <LoaderCircle size={16} className="admin-spinner" /> : <RefreshCw size={16} />}Zapisz korektę i wznów od sprawdzania</button>
      </fieldset>
      {!view.canEdit && !notice && <p role="status">Ten etap już trwa albo ma gotowy wynik. Sprawdź jego aktualny stan.</p>}
      <p>Zapis nie akceptuje treści, nie generuje zdjęć i nie publikuje przepisu.</p>
      <Link className="admin-button is-secondary" href={`/admin/recipes/${encodeURIComponent(view.recipeId)}`}>Przejdź do przepisu</Link>
    </form>}
  </div>;
}
