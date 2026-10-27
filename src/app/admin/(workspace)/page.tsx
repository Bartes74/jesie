import Link from 'next/link';
import { ArrowRight, Plus, BookOpen, CalendarClock } from 'lucide-react';
import { pageAdmin } from '@/server/auth-page';
import { listRecipes } from '@/server/editorial/store';
import { recipeListCounts } from '@/lib/editorial-presentation';
import { getAdminAttention } from '@/server/admin/attention';
import { AdminReaderFeedback } from '@/components/admin/ReaderFeedback';
import { PublicationCostReport } from '@/components/admin/PublicationCostReport';
import { Suspense } from 'react';

export default async function OverviewPage() {
  await pageAdmin();
  const [recipes, attention] = await Promise.all([listRecipes(), getAdminAttention()]);
  const counts = recipeListCounts(recipes);
  return <>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">REDAKCJA JESIE.PL</p><h1>Co dziś ugotujemy?</h1><p>Wystarczy tytuł. System przygotuje przepis, który sprawdzisz przed publikacją.</p></div><Link href="/admin/recipes/new" className="admin-button"><Plus size={19} />Dodaj przepis</Link></div>
    <div className="admin-stats" aria-label="Przepisy w serwisie"><Link href="/admin/recipes?filter=draft" className="admin-stat admin-stat-link"><strong>{counts.drafts}</strong><span>Szkice <ArrowRight size={13} /></span></Link><Link href="/admin/recipes?filter=published" className="admin-stat admin-stat-link"><strong>{counts.published}</strong><span>Opublikowane <ArrowRight size={13} /></span></Link></div>
    <section className="admin-section"><h2>Co wymaga Twojej uwagi</h2><p>Najpierw problemy i decyzje redakcyjne, na końcu praca trwająca w tle. Każdy przepis ma jedno następne działanie.</p>{attention.length ? <><table className="admin-table"><thead><tr><th scope="col">Przepis</th><th scope="col">Następny krok</th><th scope="col">Działanie</th></tr></thead><tbody>{attention.slice(0, 12).map(item => <tr key={item.id}><td><strong>{item.title}</strong><p className="admin-subtle">{new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(item.updatedAt))}</p></td><td>{item.description}</td><td><Link className="admin-text-link" href={item.href}>{item.actionLabel} <ArrowRight size={15} /></Link></td></tr>)}</tbody></table>{attention.length > 12 && <Link className="admin-text-link" href="/admin/recipes?filter=draft">Wszystkie szkice ({attention.length}) <ArrowRight size={16} /></Link>}</> : <div className="admin-empty"><h3>Brak spraw czekających na działanie.</h3><p>Dodaj pomysł lub własny przepis, aby przygotować kolejne danie.</p><Link className="admin-button" href="/admin/recipes/new"><Plus size={18} />Dodaj przepis</Link></div>}</section>
    <Suspense fallback={<p>Wczytywanie opinii…</p>}><AdminReaderFeedback /></Suspense>
    <Suspense fallback={<p>Wczytywanie kosztów…</p>}><PublicationCostReport /></Suspense>
    <div className="admin-overview-links"><Link href="/admin/recipes"><BookOpen size={23} /><div><h3>Wszystkie przepisy</h3><p>Szkice i opublikowane dania w jednym miejscu.</p></div><ArrowRight size={18} /></Link><Link href="/admin/automation"><CalendarClock size={23} /><div><h3>Codzienne inspiracje</h3><p>Oceń szkic z codziennego wyszukiwania i zdecyduj o zdjęciach.</p></div><ArrowRight size={18} /></Link></div>
  </>;
}
