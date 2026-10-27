import Link from 'next/link';
import { getReaderFeedback } from '@/server/reader-feedback';
import { ResolveReaderFeedback } from './ResolveReaderFeedback';
export async function AdminReaderFeedback() {
  const feedback = await getReaderFeedback();
  return <section className="admin-section"><h2>Głos gotujących</h2><p>Zgłoszone problemy, zmiany i udane gotowania. Prywatne notatki użytkownika nie trafiają do redakcji.</p>{!feedback.available ? <p>Opinie będą dostępne po aktualizacji bazy: npm run db:migrate.</p> : !feedback.items.length ? <p>Nie ma nowych opinii wymagających przeglądu.</p> : <div className="admin-feedback-list">{feedback.items.map(item => <article key={item.id}><h3><Link href={`/admin/recipes/${encodeURIComponent(item.recipeId)}`}>{item.title}</Link> · {{ problem: 'Problem', changed: 'Własna zmiana', success: 'Udało się' }[item.kind]}</h3><p>Wersja publikacji {item.revision}{item.stepId ? ` · krok: ${item.stepId}` : ''} · {new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' }).format(new Date(item.createdAt))}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.message || 'Przepis się udał.'}</p><ResolveReaderFeedback id={item.id} /></article>)}</div>}</section>;
}
