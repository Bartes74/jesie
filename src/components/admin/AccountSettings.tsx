'use client';
import { useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { LockKeyhole, LoaderCircle } from 'lucide-react';
const auth = createAuthClient();
export function AccountSettings() {
  const [currentPassword, setCurrent] = useState(''); const [newPassword, setNew] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  async function change(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try { const result = await auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }); if (result.error) throw new Error('Sprawdź obecne hasło i spróbuj ponownie.'); setCurrent(''); setNew(''); setNotice({ ok: true, text: 'Hasło zostało zmienione. Pozostałe sesje są wylogowane.' }); }
    catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : 'Nie udało się zmienić hasła.' }); }
    finally { setBusy(false); }
  }
  return <form className="admin-account-form" onSubmit={change}><div className="admin-field-grid"><label className="admin-field">Obecne hasło<input type="password" required autoComplete="current-password" maxLength={128} value={currentPassword} onChange={event => setCurrent(event.target.value)} disabled={busy} /></label><label className="admin-field">Nowe hasło <small>Co najmniej 12 znaków.</small><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={newPassword} onChange={event => setNew(event.target.value)} disabled={busy} /></label></div>{notice && <div role="status" className={`admin-notice ${notice.ok ? 'is-success' : 'is-error'}`}>{notice.text}</div>}<button className="admin-button" type="submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="admin-spinner" /> : <LockKeyhole size={18} />}{busy ? 'Zmieniam hasło…' : 'Zmień hasło'}</button></form>;
}
