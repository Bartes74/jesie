'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import type { AiBudgetSnapshot } from '@/lib/ai-budget-types';
import type { PhotoCostReconciliationReport } from '@/lib/photo-cost-reconciliation-types';

const usd = (value: string) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(Number(value));
const when = (value: string) => new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
async function readBudget(signal?: AbortSignal): Promise<AiBudgetSnapshot> {
  const response = await fetch('/api/admin/ai/budget', { cache: 'no-store', signal });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się wczytać kosztów.');
  if (!body.budget) throw new Error('Nie otrzymaliśmy aktualnego zestawienia kosztów.');
  return body;
}
function CostLine({ label, used }: { label: string; used: string }) {
  return <div className="admin-budget-usage-item"><span>{label}</span><strong>{usd(used)}</strong><span>Potwierdzone koszty</span></div>;
}
export function BudgetSettings() {
  const [snapshot, setSnapshot] = useState<AiBudgetSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'refresh' | 'reconcile' | null>(null);
  const [error, setError] = useState('');
  const [reconciliationReport, setReconciliationReport] = useState<PhotoCostReconciliationReport | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const snapshotRef = useRef<AiBudgetSnapshot | null>(null);
  const accept = useCallback((data: AiBudgetSnapshot) => { snapshotRef.current = data; setSnapshot(data); setNeedsRefresh(false); }, []);
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (busyRef.current) return;
    const generation = ++generationRef.current;
    const data = await readBudget(signal);
    if (signal?.aborted || busyRef.current || generation !== generationRef.current) return;
    accept(data); setError('');
  }, [accept]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController(); const current = controller;
      try { await reload(current.signal); }
      catch (err) { if (!disposed && !current.signal.aborted) setError(err instanceof Error ? err.message : 'Nie udało się wczytać kosztów.'); }
      finally { if (!disposed && !current.signal.aborted) { setLoading(false); if (!document.hidden) timer = setTimeout(() => void poll(), 30000); } }
    };
    const visible = () => { clearTimeout(timer); controller?.abort(); if (!document.hidden) void poll(); };
    void Promise.resolve().then(() => { if (!disposed) return poll(); });
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [reload]);
  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true; ++generationRef.current; setBusy('refresh'); setError('');
    try { accept(await readBudget()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Nie udało się wczytać kosztów.'); }
    finally { busyRef.current = false; setBusy(null); }
  };

  const reconcilePhotoCosts = async () => {
    if (busyRef.current || needsRefresh || !snapshotRef.current) return;
    busyRef.current = true; ++generationRef.current; setBusy('reconcile'); setError(''); setReconciliationReport(null);
    try {
      const response = await fetch('/api/admin/ai/budget/reconcile-photo-costs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reconcile' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie do panelu.' : body.error || 'Nie udało się uzgodnić kosztów zdjęć.');
      if (!body.report) throw new Error('Nie otrzymaliśmy raportu uzgodnienia kosztów zdjęć. Możesz uruchomić tę operację ponownie.');
      setReconciliationReport(body.report as PhotoCostReconciliationReport);
    } catch (err) {
      setError(err instanceof TypeError || err instanceof SyntaxError ? 'Nie otrzymaliśmy potwierdzenia uzgodnienia kosztów zdjęć. Operacja nie zostanie automatycznie ponowiona. Możesz uruchomić ją ponownie.' : err instanceof Error ? err.message : 'Nie udało się uzgodnić kosztów zdjęć.');
    } finally {
      try { accept(await readBudget()); }
      catch { setNeedsRefresh(true); setError(current => current || 'Nie udało się odświeżyć kosztów po uzgodnieniu kosztów zdjęć. Wczytaj aktualny stan przed kolejną operacją.'); }
      finally { busyRef.current = false; setBusy(null); }
    }
  };

  return <section className="admin-section admin-budget-settings" aria-labelledby="budget-settings-heading">
    <div className="admin-budget-heading"><div><h2 id="budget-settings-heading"><Wallet size={23} /> Koszty generowania</h2><p>Potwierdzone koszty tworzenia treści i zdjęć. Generowanie działa bez limitów wydatków i rezerwacji.</p></div><button type="button" className="admin-text-link admin-ai-inline-button" disabled={busy !== null || loading} onClick={() => void refresh()}><RefreshCw size={15} className={busy === 'refresh' ? 'admin-spinner' : ''} />Odśwież koszty</button></div>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><div><p>{error}</p>{needsRefresh && <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => void refresh()} disabled={busy !== null}>Wczytaj aktualny stan</button>}</div></div>}
    {loading ? <p role="status"><LoaderCircle size={18} className="admin-spinner" />Wczytywanie kosztów…</p> : !snapshot ? <p>Koszty są niedostępne. Odśwież zestawienie.</p> : <>
      <div className="admin-budget-usage" aria-label="Potwierdzone koszty"><CostLine label="Dzisiaj (UTC)" used={snapshot.budget.dailyUsedUsd} /><CostLine label="W tym miesiącu (UTC)" used={snapshot.budget.monthlyUsedUsd} /><CostLine label="Od początku" used={snapshot.budget.pilotUsedUsd} /></div>
      <p className="admin-budget-summary">Do rozliczenia: <strong>{snapshot.budget.pendingCostCount ?? 0}</strong> zleceń. Kwoty bez potwierdzenia nie są wliczone do kosztów. Zadania w toku: <strong>{snapshot.budget.activeJobs} / {snapshot.budget.concurrentLimit}</strong>.</p>
      <button type="button" className="admin-button is-secondary" disabled={busy !== null || needsRefresh} aria-describedby="photo-cost-reconciliation-description" onClick={() => void reconcilePhotoCosts()}>{busy === 'reconcile' ? <LoaderCircle size={17} className="admin-spinner" /> : <RefreshCw size={17} />}Uzgodnij koszty zdjęć</button><p className="admin-budget-summary" id="photo-cost-reconciliation-description">Odczytuje istniejące rachunki za zdjęcia i aktualizuje rzeczywisty koszt.</p>
      {reconciliationReport && <div className="admin-notice" role="status"><CheckCircle2 size={18} /><div><p><strong>Odczyt rachunków · {when(reconciliationReport.checkedAt)}</strong></p><p>Sprawdzono: {reconciliationReport.scannedJobs}. Uzgodniono: {reconciliationReport.reconciledJobs}. Oczekuje na rachunek: {reconciliationReport.pendingJobs}. Wcześniej rozliczono: {reconciliationReport.alreadySettledJobs}.</p><p>Potwierdzony koszt sprawdzanych zleceń: <strong>{usd(reconciliationReport.verifiedCostUsd)}</strong>.</p>{reconciliationReport.read.status !== 'verified' && <p>Część rachunków jest niedostępna lub wymaga ponownego odczytu. Niepotwierdzone koszty pozostają do rozliczenia.</p>}{reconciliationReport.limited && <p>Pozostałe zlecenia do sprawdzenia: {reconciliationReport.remainingJobs}. Operacja sprawdza maksymalnie 500 zleceń naraz.</p>}</div></div>}
    </>}
  </section>;
}
