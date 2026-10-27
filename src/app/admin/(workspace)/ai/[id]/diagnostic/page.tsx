import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAdmin } from '@/server/auth-page';
import { getJobForExecution } from '@/server/ai/store';
import { inspectAcceptedPhotoReceipt } from '@/server/ai/image-provider';

export const maxDuration = 180;
export const metadata = { title: 'Diagnostyka zdjęcia' };

export default async function PhotoDiagnosticPage({ params }: { params: Promise<{ id: string }> }) {
  await pageAdmin();
  const { id } = await params;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) notFound();
  const job = await getJobForExecution(id);
  const diagnostic = await inspectAcceptedPhotoReceipt(job, true);
  return <div className="admin-seo-status">
    <div className="admin-page-heading"><div>
      <p className="admin-eyebrow">ODCZYT ISTNIEJĄCEGO ZLECENIA</p>
      <h1>Diagnostyka zdjęcia</h1>
      <p>{job.input.recipe.title.pl}</p>
    </div></div>
    <section className="admin-seo-card">
      <h2>Wynik kontroli</h2>
      <p>Kontrola odczytuje zachowane zgłoszenie. Nie uruchamia generowania ani nie zmienia zdjęć i szkicu.</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(diagnostic, null, 2)}</pre>
      <Link className="admin-text-link" href={`/admin/ai/${id}`}>Wróć do zlecenia</Link>
    </section>
  </div>;
}
