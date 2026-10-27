'use client';
import { useState } from 'react';
export function PublicSnapshotStatus({ initial }: { initial: { enabled: boolean; ready: boolean; capturedAt: number | null } }) {
  const [status, setStatus] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try { const result = await fetch('/api/admin/public-snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const body = await result.json(); if (!result.ok) throw new Error(); setStatus({ enabled: body.enabled, ready: body.state === 'ready', capturedAt: body.capturedAt ?? null }); }
    catch { setError('Nie udało się odnowić kopii. Aktualne publikacje nadal odczytujemy z bazy.'); } finally { setBusy(false); }
  }
  return <section className="admin-section"><h2>Kopia publicznego katalogu</h2><p>{!status.enabled ? 'Wymaga konfiguracji przed uruchomieniem. Publiczne strony korzystają z bazy.' : status.ready ? 'Aktualna kopia jest gotowa na chwilową niedostępność bazy.' : 'Kopia jest nieaktualna lub została unieważniona po zmianie publikacji.'}</p>{status.capturedAt && <p>Ostatnie odnowienie: {new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(status.capturedAt))}</p>}{status.enabled && <button type="button" className="admin-button is-secondary" disabled={busy} onClick={() => void refresh()}>{busy ? 'Odnawiam…' : 'Odnów kopię teraz'}</button>}{error && <p role="alert">{error}</p>}<p>Kopia obejmuje wyłącznie opublikowane treści, jest odnawiana co godzinę i wygasa po 24 godzinach. Wycofanie przepisu unieważnia ją przed zmianą publikacji. Dostępność zdjęć nadal podlega osobnej kontroli.</p></section>;
}
