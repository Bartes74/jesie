'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReviewedSchedule } from '@/server/trends/publication';

/** Legacy view retained for old imports; publication is always a manual editor action. */
export function ReviewedPublicationPanel({ initial }: { initial: ReviewedSchedule; owner: boolean }) {
  return <section className="admin-section"><h2>Ręczna publikacja</h2><p>Sprawdź treść i fotografie, a gotowy przepis opublikuj w edytorze. Codzienne inspiracje przygotowują wyłącznie tekst szkicu.</p>
    {initial.readyRecipes.length > 0 && <ol>{initial.readyRecipes.slice(0, 10).map(recipe => <li key={recipe.id}><Link href={`/admin/recipes/${encodeURIComponent(recipe.id)}`}>{recipe.title}</Link></li>)}</ol>}
    <Link className="admin-text-link" href="/admin/automation">Codzienne inspiracje i szkice do oceny</Link>
  </section>;
}

export function DiscoveryRecoveryButton({ backfill = false }: { backfill?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const router = useRouter();
  async function recover() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/admin/seo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: backfill ? 'backfill' : 'recover' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Nie udało się ponowić obsługi.');
      setMessage(`${backfill ? `Dodano ${body.backfill.queued} zgłoszeń aktualnych publikacji.` : `Obsłużono ${body.discovery.completed} zdarzeń.`} Uruchomiono ${body.workers.started} zgłoszeń.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Brak połączenia.'); }
    finally { setBusy(false); }
  }
  return <div><button type="button" className="admin-button is-secondary" disabled={busy} onClick={() => void recover()}>{busy ? 'Uruchamiam obsługę…' : backfill ? 'Zgłoś istniejące publikacje' : 'Ponów obsługę publikacji'}</button>{message && <p role="status">{message}</p>}</div>;
}
