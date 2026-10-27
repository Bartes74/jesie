'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createAuthClient } from 'better-auth/react';
import { CookingPot, ArrowRight, Eye, EyeOff, LoaderCircle, ShieldCheck } from 'lucide-react';

const authClient = createAuthClient();

export function AccessForm({ setup = false }: { setup?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [activated, setActivated] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setPending(true);
    try {
      if (setup && !activated) {
        const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
        if (!token) throw new Error('Otwórz pełny link aktywacyjny otrzymany od właściciela.');
        const response = await fetch('/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, email, name, password }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Nie udało się aktywować konta.');
        history.replaceState(null, '', '/admin/setup');
        setActivated(true);
      }
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error('Nie udało się zalogować. Sprawdź e-mail i hasło lub spróbuj ponownie później.');
      router.push('/admin'); router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Wystąpił błąd połączenia. Spróbuj ponownie.'); setPending(false); }
  };
  return <main id="admin-main" className="admin-access">
    <div className="admin-access-story"><Link href="/pl" className="admin-brand"><CookingPot size={40} strokeWidth={1.3} />jesie.pl</Link><div><p className="admin-eyebrow">TWOJA PRZESTRZEŃ REDAKCYJNA</p><h1>Dobry przepis<br />zaczyna się tutaj.</h1><p>Od pierwszego szkicu do dania, którym chcesz się podzielić.</p></div><span>Trochę inspiracji. Dużo przyjemności z gotowania.</span></div>
    <div className="admin-access-form"><div><p className="admin-eyebrow">REDAKCJA JESIE.PL</p><h2>{setup ? 'Zaczynamy.' : 'Dobrze Cię widzieć.'}</h2><p>{setup ? 'Aktywuj swoje konto i ustaw własne hasło. Link aktywacyjny jest jednorazowy.' : 'Zaloguj się, aby wrócić do swoich przepisów.'}</p>
      <form onSubmit={submit}>
        {setup && <label className="admin-field">Twoje imię<input autoComplete="given-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} /></label>}
        <label className="admin-field">E-mail<input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} /></label>
        <label className="admin-field">{setup ? 'Nowe hasło' : 'Hasło'}<span className="admin-password-field"><input type={showPassword ? 'text' : 'password'} autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} minLength={setup ? 12 : undefined} maxLength={128} required /><button type="button" className="admin-icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Ukryj hasło' : 'Pokaż hasło'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>{setup && <small>Co najmniej 12 znaków. Możesz użyć menedżera haseł.</small>}</label>
        {error && <p className="admin-notice is-error" role="alert">{error}</p>}
        <button type="submit" className="admin-button" disabled={pending}>{pending ? <LoaderCircle className="admin-spinner" size={18} /> : <ArrowRight size={18} />}{pending ? 'Chwila…' : setup ? 'Aktywuj konto i przejdź do panelu' : 'Zaloguj się'}</button>
      </form>
      <p className="admin-access-note"><ShieldCheck size={16} />Dostęp tylko dla zaproszonych administratorów.</p><Link href="/pl" className="admin-text-link">Wróć do serwisu →</Link>
    </div></div>
  </main>;
}
