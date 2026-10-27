import type { Metadata } from 'next';
import { PUBLIC_SITE_URL, publicRobots } from '@/lib/seo';

export const metadata: Metadata = { metadataBase: new URL(PUBLIC_SITE_URL), robots: publicRobots() };

export default function EntryLayout({ children }: { children: React.ReactNode }) {
  return <html lang="pl"><body>{children}</body></html>;
}
