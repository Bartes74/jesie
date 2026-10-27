import Link from 'next/link';
import type { PublicationPlanEntry } from '@/server/trends/publication-plan';

type Choice = { id: string; title: string; revision: number };
const when = (date: string) => new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' }).format(new Date(`${date}T12:00:00Z`));

/** Historical plan display only. New publication decisions belong to the primary editor. */
export function PublicationPlanPanel({ initial }: { initial: PublicationPlanEntry[]; choices: Choice[]; owner: boolean; nextDate: string }) {
  return <section className="admin-section" aria-labelledby="publication-plan-heading">
    <h2 id="publication-plan-heading">Historia dawnego planu publikacji</h2>
    <p>Dawne terminy pozostają w historii. Każdy gotowy przepis publikujesz teraz ręcznie w edytorze.</p>
    {initial.length > 0 ? <div className="admin-seo-log"><table className="admin-table"><thead><tr><th scope="col">Dawny termin</th><th scope="col">Przepis</th></tr></thead><tbody>{initial.map(item => <tr key={item.date}>
      <td>{when(item.date)}</td><td><Link href={`/admin/recipes/${encodeURIComponent(item.recipeId)}`}>{item.title}</Link></td>
    </tr>)}</tbody></table></div> : <p>Brak zapisanych dawnych terminów.</p>}
    <Link className="admin-text-link" href="/admin/automation">Codzienne inspiracje i szkice do oceny</Link>
  </section>;
}
