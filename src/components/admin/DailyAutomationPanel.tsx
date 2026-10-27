'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyAutomationDashboard } from '@/server/trends/automated-publication';
import { dailyAutomationStatus } from '@/lib/daily-automation-status';

function localTime(value: string) {
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(value));
}

const researchStatus: Record<string, string> = { queued: 'Czeka na rozpoczęcie', searching: 'Sprawdzamy aktualne trendy', generating: 'Opracowujemy tekst przepisu', awaiting_review: 'Szkic czeka na Twoją ocenę', published: 'Opublikowano', deleted: 'Przepis w Koszu', archived: 'Przepis w archiwum', no_candidate: 'Brak wybranej propozycji', uncertain: 'Zlecenie wymaga sprawdzenia', failed: 'Przygotowanie wymaga sprawdzenia', paused: 'Wstrzymano', rejected: 'Odrzucono' };

export function DailyAutomationPanel({ initial, owner }: { initial: DailyAutomationDashboard; owner: boolean }) {
  const [automation, setAutomation] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const busyRef = useRef(false);
  const requestGeneration = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (busyRef.current) return;
    const generation = ++requestGeneration.current;
    const response = await fetch('/api/admin/automation', { cache: 'no-store', signal });
    const body = await response.json();
    if (!response.ok || !body.automation) throw new Error(body.error || 'Nie udało się odświeżyć stanu automatu.');
    if (!signal?.aborted && generation === requestGeneration.current && !busyRef.current) { setAutomation(body.automation); setError(''); }
  }, []);
  useEffect(() => {
    let controller: AbortController | undefined;
    const update = () => {
      controller?.abort();
      if (document.hidden || busyRef.current) return;
      controller = new AbortController(); const current = controller;
      void refresh(current.signal).catch(failure => { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Nie udało się odświeżyć stanu.'); });
    };
    const timer = setInterval(update, 30_000);
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); controller?.abort(); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  const toggle = async (enabled = !automation.enabled) => {
    if (busyRef.current) return;
    busyRef.current = true; ++requestGeneration.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/automation', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, ...(enabled && automation.autoPauseToken && acknowledged === automation.autoPauseToken ? { expectedAutoPauseToken: automation.autoPauseToken } : {}) }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Nie udało się zapisać ustawienia.');
      setAutomation(body.automation); setAcknowledged(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Nie udało się zapisać ustawienia.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const status = dailyAutomationStatus(automation);
  return <>
    <section className="admin-section">
      <h2>Codziennie nowy pomysł do Twojej oceny</h2>
      <p>System wyszukuje aktualne propozycje, wybiera trend lub inspirację i opracowuje tekst przepisu po polsku i angielsku. Gotowy szkic czeka na Ciebie w panelu.</p>
      <p role="status"><strong>{status.label}</strong></p>
      {automation.reason && <p role="status">{automation.reason}</p>}
      <p>Następne wyszukiwanie: <strong>{localTime(automation.nextSearchAt)}</strong>.</p>
      <p>Ty oceniasz i zatwierdzasz treść, decydujesz o przygotowaniu zdjęć, a gotowy przepis publikujesz ręcznie w edytorze. Włączenie codziennego wyszukiwania nie zleca fotografii ani publikacji.</p>
      <p><Link href="/admin/trends/budget">Koszty i rachunki radaru</Link> · <Link href="/admin/recipes?filter=draft">Wszystkie szkice</Link></p>
      <p className="admin-subtle">Ostatnia kontrola: {localTime(automation.serverNow)}. <button className="admin-text-link" type="button" disabled={busy} onClick={() => void refresh().catch(failure => setError(failure instanceof Error ? failure.message : 'Nie udało się odświeżyć stanu.'))}>Odśwież stan</button></p>
      {owner && automation.autoPauseToken && <label className="admin-checkbox"><input type="checkbox" checked={acknowledged === automation.autoPauseToken} onChange={event => setAcknowledged(event.target.checked ? automation.autoPauseToken : null)} disabled={busy} /><span>Sprawdziłem przyczynę zatrzymania i chcę wznowić codzienne wyszukiwanie.</span></label>}
      {owner && <div className="admin-actions">{automation.enabled && !automation.operational && automation.autoPauseToken && <button className="admin-button" type="button" disabled={busy || !automation.canEnable || acknowledged !== automation.autoPauseToken} onClick={() => void toggle(true)}>Wznów wyszukiwanie</button>}<button className="admin-button is-secondary" type="button" disabled={busy || !automation.enabled && (!automation.canEnable || Boolean(automation.autoPauseToken && acknowledged !== automation.autoPauseToken))} onClick={() => void toggle()}>{busy ? 'Zapisuję…' : automation.enabled ? 'Wyłącz codzienne wyszukiwanie' : 'Włącz codzienne wyszukiwanie'}</button>{!automation.operational && automation.enabled && !automation.autoPauseToken && <Link className="admin-text-link" href="/admin/settings">Sprawdź ustawienia</Link>}</div>}
      {!owner && <p>Codzienne wyszukiwanie może włączyć lub wyłączyć właściciel serwisu.</p>}
      {error && <p role="alert" className="admin-error">{error}</p>}
      <p className="admin-subtle">Oznaczenie „Popularne teraz” wymaga potwierdzonych, aktualnych dowodów. Pozostałe propozycje są inspiracjami; brak potwierdzenia trendu nie zastępuje Twojej oceny przepisu.</p>
    </section>
    <section className="admin-section" aria-labelledby="daily-draft-review-heading">
      <h2 id="daily-draft-review-heading">Szkice do Twojej oceny</h2>
      <p>Otwórz szkic, sprawdź oba języki, składniki i kroki. Dopiero po akceptacji treści zdecyduj o zdjęciach.</p>
      {automation.reviewQueue.length ? <ul>{automation.reviewQueue.map(draft => <li key={draft.runId}><strong>{draft.title}</strong> · {draft.date}<div className="admin-actions"><Link className="admin-button is-secondary" href={`/admin/recipes/${encodeURIComponent(draft.recipeId)}`}>Sprawdź treść i zdecyduj o zdjęciach</Link><Link className="admin-text-link" href={`/admin/trends/${encodeURIComponent(draft.runId)}`}>Źródła i przebieg</Link></div></li>)}</ul> : <p>Nie ma nowych szkiców czekających na ocenę. Wynik kolejnego przygotowania pojawi się tutaj.</p>}
    </section>
    {automation.latestResearch && <section className="admin-section"><h2>Ostatnie wyszukiwanie i opracowanie</h2><p>{automation.latestResearch.date} · {researchStatus[automation.latestResearch.status] || automation.latestResearch.status}</p>{automation.latestResearch.title && <p>{automation.latestResearch.recipeId ? <Link href={`/admin/recipes/${encodeURIComponent(automation.latestResearch.recipeId)}`}>{automation.latestResearch.title}</Link> : automation.latestResearch.title} · {automation.latestResearch.confirmedTrend ? 'potwierdzony trend społecznościowy' : 'inspiracja do ręcznego sprawdzenia'}</p>}{automation.latestResearch.reason && <p>{automation.latestResearch.reason}</p>}<Link className="admin-text-link" href={`/admin/trends/${encodeURIComponent(automation.latestResearch.runId)}`}>Sprawdź źródła, postęp i koszty</Link></section>}
  </>;
}
