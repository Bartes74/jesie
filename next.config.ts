import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { legacyRedirects } from "./src/lib/legacy-redirects";

const config: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  // Metadata accompanies the initial document for all crawlers and readers.
  htmlLimitedBots: /.*/,
  outputFileTracingIncludes: {
    '/.well-known/workflow/**': ['./private-media/provider-recovery/**', './private-media/published-recovery/**', './private-media/quota-public-recovery/**', './public/images/**', './src/server/media-backup/schema/**'],
    '/media/*': ['./private-media/published-recovery/**', './private-media/quota-public-recovery/**'],
    '/media/recipes/**': ['./public/images/**', './private-media/published-recovery/**', './private-media/quota-public-recovery/**'],
    '/media/static/**': ['./public/images/**'],
    '/api/admin/**': ['./private-media/published-recovery/**'],
    '/admin/**': ['./private-media/published-recovery/**'],
    '/api/cron/**': ['./private-media/published-recovery/**'],
    '/api/cron/media': ['./private-media/provider-recovery/**', './private-media/published-recovery/**', './private-media/quota-public-recovery/**', './public/images/**', './src/server/media-backup/schema/**'],
    '/api/cron/seo': ['./public/images/**', './private-media/published-recovery/**'],
    '/api/cron/trends': ['./public/images/**', './private-media/published-recovery/**'],
    '/api/cron/trends/publish': ['./public/images/**', './private-media/published-recovery/**'],
    '/api/admin/seo': ['./public/images/**', './private-media/published-recovery/**'],
    '/api/admin/recipes/\\[id\\]/actions': ['./public/images/**'],
  },
  redirects() {
    return legacyRedirects;
  },
  headers() {
    const indexable = process.env.VERCEL_ENV ? process.env.VERCEL_ENV === 'production' : process.env.NODE_ENV === 'production' && process.env.SEO_INDEXING_ENABLED === 'true';
    const noindex = [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }];
    return indexable ? [
      { source: '/admin/:path*', headers: noindex },
      { source: '/:locale/preview/:path*', headers: noindex },
      { source: '/api/:path*', headers: noindex },
    ] : [{ source: '/:path*', headers: noindex }];
  },
};
export default withWorkflow(config);
