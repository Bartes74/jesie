'use client';
import { useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AiPhotoBatch } from '@/lib/ai-photo-batch-types';

type Props = { batch: AiPhotoBatch; jobId: string; expectedRevision: number; disabled: boolean;
  onBatchUpdated: (batch: AiPhotoBatch) => void; onBusyChange: (busy: boolean) => void };
const wineBrief = 'Popraw sprawdzone błędne zdjęcie: wytrawne białe wino jest klarownym, jasnosłomkowym płynem w małym kompletnym szklanym naczyniu. Nie pokazuj płatków, proszku, suszonych składników ani octu. Zachowaj jednolite tło serwisu #FAF8F2 i naturalny cień.';

export function ReviewedIngredientRetakeButton({ batch, jobId, expectedRevision, disabled, onBatchUpdated, onBusyChange }: Props) {
  const [expanded, setExpanded] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [reviewNote, setReviewNote] = useState(wineBrief); const request = useRef<{ generation: number; expectedRevision: number; targetId: 'white_wine'; replacedJobId: string; reviewNote: string; requestKey: string } | null>(null);
  const inFlight = useRef(false);
  const replace = async () => {
    if (disabled || inFlight.current || !batch.generation || !reviewNote.trim()) return;
    if (!request.current) request.current = { generation: batch.generation, expectedRevision, targetId: 'white_wine', replacedJobId: jobId, reviewNote: reviewNote.trim(), requestKey: crypto.randomUUID() };
    inFlight.current = true; setBusy(true); setUnconfirmed(true); setError(''); onBusyChange(true);
    try {
      const response = await fetch('/api/admin/ai/photo-batches/' + encodeURIComponent(batch.id) + '/replace-ingredient', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.current) });
      const data = await response.json();
      if (!response.ok) { if (response.status < 500) { request.current = null; setUnconfirmed(false); } throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : data.error || 'Nie udało się przygotować poprawki.'); }
      if (data.batch?.id !== batch.id) throw new Error('Nie otrzymano potwierdzenia. Sprawdź to samo zgłoszenie ponownie.');
      setUnconfirmed(false); onBatchUpdated(data.batch);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Brak połączenia. Sprawdź to samo zgłoszenie ponownie.'); }
    finally { inFlight.current = false; setBusy(false); onBusyChange(false); }
  };
  return <div>
    <button type="button" className="admin-text-link admin-ai-inline-button" disabled={disabled || busy || !batch.generation} onClick={() => setExpanded(value => !value)} aria-expanded={expanded}><RefreshCw size={13} />Popraw zdjęcie składnika</button>
    {expanded && <div><label htmlFor={'ingredient-retake-' + jobId}>Co powinno być widoczne na zdjęciu?</label><textarea id={'ingredient-retake-' + jobId} value={reviewNote} maxLength={1000} disabled={disabled || busy || unconfirmed} onChange={event => setReviewNote(event.target.value)} />
      <p>Poprawka wymaga maksymalnie 0,50 USD w pierwotnym limicie tego pakietu. Poprzednie zdjęcie i jego koszt pozostaną w historii.</p>
      <button type="button" className="admin-button is-secondary" disabled={disabled || busy || !reviewNote.trim()} onClick={() => void replace()}>{busy ? <LoaderCircle size={15} className="admin-spinner" /> : <RefreshCw size={15} />}{unconfirmed ? 'Sprawdź zgłoszenie poprawki' : 'Przygotuj poprawione zdjęcie'}</button>
    </div>}
    {error && <p className="admin-photo-batch-slot-error" role="alert">{error}</p>}
  </div>;
}
