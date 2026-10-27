import { LockKeyhole, UserRound } from 'lucide-react';
import { pageAdmin } from '@/server/auth-page';
import { AccountSettings } from '@/components/admin/AccountSettings';
import { BudgetSettings } from '@/components/admin/BudgetSettings';
import { MediaMaintenanceStatus } from '@/components/admin/MediaMaintenanceStatus';
import { PublicSnapshotStatus } from '@/components/admin/PublicSnapshotStatus';
import { getPublicReadModelStatus } from '@/server/public/read-model';

export default async function SettingsPage() {
  const { user } = await pageAdmin();
  const snapshot = await getPublicReadModelStatus();
  return <><div className="admin-page-heading"><div><h1>Twoje konto, Twoja redakcja.</h1><p>Indywidualny dostęp do jesie.pl.</p></div></div><section className="admin-section"><h2><UserRound size={22} /> Konto</h2><dl className="admin-dl"><dt>Imię</dt><dd>{user.name}</dd><dt>E-mail</dt><dd>{user.email}</dd><dt>Uprawnienia</dt><dd>{user.role === 'owner' ? 'Właściciel' : 'Administrator'}</dd></dl></section><section className="admin-section"><h2><LockKeyhole size={23} /> Zmień hasło</h2><p>Po zmianie wylogujemy pozostałe sesje tego konta.</p><AccountSettings /></section><BudgetSettings /><MediaMaintenanceStatus /><PublicSnapshotStatus initial={snapshot} /><section className="admin-section"><h2>Serwis</h2><dl className="admin-dl"><dt>Nazwa</dt><dd>jesie.pl</dd><dt>Języki</dt><dd>Polski i angielski (UK)</dd><dt>Dostęp czytelników</dt><dd>Otwarty; panel wymaga logowania.</dd><dt>Publikacja</dt><dd>Ręczna w edytorze. Radar codziennie przygotowuje tekst szkicu do Twojej oceny.</dd></dl></section></>;
}
