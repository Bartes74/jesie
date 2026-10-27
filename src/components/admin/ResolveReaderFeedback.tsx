'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function ResolveReaderFeedback({ id }: { id: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [error, setError] = useState('');
  async function resolve() {
    setBusy(true); setError('');
    try { const result = await fetch('/api/admin/feedback', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); if (!result.ok) throw new Error(); setDone(true); router.refresh(); }
    catch { setError('Nie udało się oznaczyć opinii. Spróbuj ponownie.'); } finally { setBusy(false); }
  }
  return <div>{done ? <p role="status">Przejrzane.</p> : <button type="button" className="admin-button is-secondary" onClick={() => void resolve()} disabled={busy}>{busy ? 'Zapisuję…' : 'Oznacz jako przejrzane'}</button>}{error && <p role="alert">{error}</p>}</div>;
}
