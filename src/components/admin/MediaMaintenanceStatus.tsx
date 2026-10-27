import { DatabaseBackup } from 'lucide-react';
import { mediaMaintenanceHealth } from '@/server/media-maintenance/health';

const phases:Record<string,string>={warm:'przygotowanie rozmiarów zdjęć',snapshot:'kopia bazy',media:'kopia zdjęć',bundle:'kopia plików aplikacji',catalog:'katalog archiwów',restore:'test odtwarzania bazy',finalize:'weryfikacja kompletności',retention:'rotacja kopii'};
export async function MediaMaintenanceStatus() {
  const health=await mediaMaintenanceHealth();
  if(!health.available)return <section className="admin-section"><h2><DatabaseBackup size={22}/> Kopie i zdjęcia</h2><p>Status jest chwilowo niedostępny. Serwis ponowi kontrolę automatycznie.</p></section>;
  const when=health.lastBackupAt?new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',dateStyle:'medium',timeStyle:'short'}).format(new Date(health.lastBackupAt)):null;
  return <section className="admin-section" aria-labelledby="media-maintenance-heading"><h2 id="media-maintenance-heading"><DatabaseBackup size={22}/> Kopie i zdjęcia</h2>
    <p>{health.enabled?'Codzienna kopia i automatyczne wznawianie zadań są włączone.':'Automatyczne kopie są wyłączone.'}</p>
    <dl className="admin-dl"><dt>Ostatnia pełna kopia</dt><dd>{when??(health.active?'Pierwsza kopia nie została jeszcze potwierdzona':'Oczekuje na pierwszy przebieg')}</dd><dt>Odtworzenie bazy testowej</dt><dd>{health.restoreVerified?'Sprawdzone pomyślnie':'Oczekuje na zakończenie kopii'}</dd><dt>Gotowe rozmiary zdjęć</dt><dd>{health.variants.toLocaleString('pl-PL')}</dd><dt>Pliki w ostatniej kopii</dt><dd>{health.objects.toLocaleString('pl-PL')}</dd><dt>Przechowywanie kopii</dt><dd>30 dziennych i 12 miesięcznych punktów przywracania</dd></dl>
    {health.active&&<p role="status">{health.active.retry?'Zadanie oczekuje na automatyczną ponowną próbę':'W toku'}: {phases[health.active.phase]??'kontrola kopii'}.</p>}
    {health.stale&&<p role="status">Ostatnia pełna kopia wymaga odświeżenia. Automatyczne próby nadal działają.</p>}
    <p>Rozmiary zdjęć zapisujemy przy pierwszym przygotowaniu i wykorzystujemy ponownie. Oryginały oraz historię przepisów zachowujemy.</p>
  </section>;
}
