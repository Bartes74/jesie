'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { CookingPot, LayoutDashboard, BookOpen, Images, Settings2, LogOut, Menu, X, ArrowUpRight, Sparkles, Radar, Search, CalendarClock, LibraryBig } from 'lucide-react';
import { createAuthClient } from 'better-auth/react';

const authClient = createAuthClient();
const links = [{ href: '/admin', label: 'Przegląd', icon: LayoutDashboard }, { href: '/admin/recipes', label: 'Przepisy', icon: BookOpen }, { href: '/admin/collections', label: 'Kolekcje', icon: LibraryBig }, { href: '/admin/automation', label: 'Codzienne inspiracje', icon: CalendarClock }, { href: '/admin/settings', label: 'Ustawienia', icon: Settings2 }];
const extraLinks = [{ href: '/admin/seo', label: 'SEO i odkrywanie', icon: Search }, { href: '/admin/trends', label: 'Szczegóły trendów', icon: Radar }, { href: '/admin/ai', label: 'Studio zaawansowane', icon: Sparkles }, { href: '/admin/library', label: 'Biblioteka zdjęć', icon: Images }];

export function AdminShell({ children, user }: { children: React.ReactNode; user: { name: string; email: string; role: string } }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const logout = async () => {
    setSigningOut(true); setError('');
    try { const result = await authClient.signOut(); if (result.error) throw new Error(); router.push('/admin/login'); router.refresh(); }
    catch { setError('Nie udało się wylogować. Spróbuj ponownie.'); setSigningOut(false); }
  };
  return <div className="admin-shell">
    <div className="admin-mobile-bar"><Link href="/admin" className="admin-brand"><CookingPot size={26} strokeWidth={1.4} />jesie.pl</Link><button type="button" className="admin-icon-button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="admin-sidebar" aria-label={menuOpen ? 'Zamknij nawigację' : 'Otwórz nawigację'}>{menuOpen ? <X /> : <Menu />}</button></div>
    {menuOpen && <button type="button" className="admin-nav-backdrop" onClick={() => setMenuOpen(false)} aria-label="Zamknij nawigację" />}
    <aside id="admin-sidebar" className={`admin-sidebar${menuOpen ? ' is-open' : ''}`}>
      <Link href="/admin" className="admin-brand"><CookingPot size={36} strokeWidth={1.3} />jesie.pl</Link>
      <nav aria-label="Nawigacja redakcji">{links.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={pathname === href || (href !== '/admin' && pathname.startsWith(`${href}/`)) ? 'is-active' : ''} aria-current={pathname === href || (href !== '/admin' && pathname.startsWith(`${href}/`)) ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon size={20} strokeWidth={1.5} />{label}</Link>)}</nav>
      <details className="admin-extra-nav" open={extraLinks.some(item => pathname === item.href || pathname.startsWith(`${item.href}/`))}><summary>Narzędzia dodatkowe</summary><nav aria-label="Narzędzia dodatkowe">{extraLinks.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={pathname === href || pathname.startsWith(`${href}/`) ? 'is-active' : ''} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon size={18} />{label}</Link>)}</nav></details>
      <div className="admin-user"><span className="admin-avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.role === 'owner' ? 'Właściciel' : 'Administrator'}</small></div><button type="button" className="admin-icon-button" onClick={logout} disabled={signingOut} aria-label="Wyloguj się"><LogOut size={18} /></button></div>
      {error && <p className="admin-sidebar-error" role="alert">{error}</p>}
    </aside>
    <div className="admin-workspace"><div className="admin-global-topbar"><span>Redakcja <span aria-hidden="true">/</span> {[...links, ...extraLinks].find(item => pathname === item.href || (item.href !== '/admin' && pathname.startsWith(`${item.href}/`)))?.label ?? 'Przepis'}</span><a href="/pl" target="_blank" rel="noopener">Zobacz serwis <ArrowUpRight size={14} /></a></div><main id="admin-main" className="admin-main">{children}</main></div>
  </div>;
}
