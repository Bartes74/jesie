import { pageAdmin } from '@/server/auth-page';
import { getAboutPage } from '@/server/site-pages';
import { AboutPageEditor } from '@/components/admin/AboutPageEditor';

export default async function AboutPageSettings() {
  await pageAdmin();
  return <AboutPageEditor initialPage={await getAboutPage()} />;
}
