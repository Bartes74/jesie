import Link from 'next/link';
import Decimal from 'decimal.js';
import { getPublicationCosts } from '@/server/admin/publication-costs';
const money = (value: string | Decimal) => `${new Decimal(value).toFixed(3)} USD`;
export async function PublicationCostReport() {
  const rows = await getPublicationCosts();
  const total = (field: 'confirmedUsd' | 'correctionsUsd' | 'costUsd') => rows.reduce((sum, row) => sum.plus(row[field]), new Decimal(0));
  const drafts = rows.filter(row => !row.published).reduce((sum, row) => sum.plus(row.costUsd), new Decimal(0));
  const released = rows.filter(row => row.published);
  const average = released.length ? released.reduce((sum, row) => sum.plus(row.costUsd), new Decimal(0)).div(released.length) : null;
  const pending = rows.reduce((sum, row) => sum + row.pendingCostCount, 0);
  return <section className="admin-section"><h2>Koszt przepisów i poprawek</h2><p>Cały okres działania. Uwzględniamy wyłącznie potwierdzone rozliczenia. Każde zlecenie i wyszukiwanie liczymy raz. Niepotwierdzone koszty pozostają do rozliczenia.</p><div className="admin-stats"><div className="admin-stat"><strong>{money(total('confirmedUsd'))}</strong><span>Potwierdzone koszty</span></div><div className="admin-stat"><strong>{money(total('correctionsUsd'))}</strong><span>W tym poprawki</span></div><div className="admin-stat"><strong>{pending}</strong><span>Do rozliczenia</span></div></div><p>Potwierdzone koszty materiałów bez publikacji: <strong>{money(drafts)}</strong>. {average && <>Średni potwierdzony koszt przepisu z historią publikacji: <strong>{money(average)}</strong>.</>}</p><details><summary>Koszt poszczególnych przepisów</summary><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Przepis</th><th>Potwierdzony koszt</th><th>W tym poprawki</th><th>Do rozliczenia</th><th>Publikacja</th></tr></thead><tbody>{rows.filter(row => new Decimal(row.costUsd).gt(0) || row.pendingCostCount > 0).map(row => <tr key={row.id || 'research'}><td>{row.id ? <Link href={`/admin/recipes/${encodeURIComponent(row.id)}`}>{row.title}</Link> : row.title}</td><td>{money(row.costUsd)}</td><td>{money(row.correctionsUsd)}</td><td>{row.pendingCostCount}</td><td>{row.published ? 'Ma publikację w historii' : 'Bez publikacji'}</td></tr>)}</tbody></table></div><p>Poprawki to kolejne płatne zlecenia dla tego samego fragmentu (tekst, zdjęcie główne, składnik lub krok), według kolejności utworzenia. Kwoty mogą wzrosnąć po otrzymaniu brakujących rachunków.</p></details></section>;
}
