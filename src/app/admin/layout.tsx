import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@/components/admin/admin.css';
import '@/components/admin/guided-recipe.css';
import '@/components/content-hubs.css';

const lora = localFont({ src: [{ path: '../../fonts/lora.woff2', weight: '400 700' }, { path: '../../fonts/lora-latin-ext.woff2', weight: '400 700' }], variable: '--font-lora', display: 'swap' });
const manrope = localFont({ src: [{ path: '../../fonts/manrope.woff2', weight: '200 800' }, { path: '../../fonts/manrope-latin-ext.woff2', weight: '200 800' }], variable: '--font-manrope', display: 'swap' });
export const metadata: Metadata = { title: { default: 'Redakcja · jesie.pl', template: '%s · Redakcja jesie.pl' }, robots: { index: false, follow: false } };

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="pl" className={`${lora.variable} ${manrope.variable}`}><body className="admin-body"><a className="admin-skip" href="#admin-main">Przejdź do treści</a>{children}</body></html>;
}
