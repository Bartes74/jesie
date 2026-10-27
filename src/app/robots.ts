import type { MetadataRoute } from 'next';
import { PUBLIC_SITE_URL, absoluteUrl, isProductionIndexable } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  if (!isProductionIndexable()) return { rules: { userAgent: '*', disallow: '/' } };
  // The wildcard also grants search, retrieval and training crawlers access.
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/api/', '/*/preview/'] },
    sitemap: absoluteUrl('/sitemap.xml'),
    host: PUBLIC_SITE_URL,
  };
}
