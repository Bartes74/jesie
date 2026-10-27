import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { getGuideHref, guides } from '@/lib/content-hubs';
import { getPublicCollections } from '@/server/public/collections';
import { getRecipeHref, type Locale } from '@/lib/recipes';
import { isProductionIndexable, PUBLIC_SITE_URL } from '@/lib/seo';
import { isUsageBot, parseUsageEvent, usageBodyLimit, usageDay, usageEventNames, usagePath, usagePeriod, usageSources, type UsageEvent, type UsageEventName, type UsageSource } from '@/lib/usage-metrics';
import { getDb } from '@/server/db';
import { publicRecipe, publicRecipes } from '@/server/public/recipes';

export type UsageSummary = {
  enabled: boolean;
  period: ReturnType<typeof usagePeriod>;
  total: number;
  events: Array<{ name: UsageEventName; count: number }>;
  sources: Array<{ source: UsageSource; count: number }>;
  paths: Array<{ path: string; count: number }>;
  pageViews: Array<{ path: string; count: number }>;
  interactions: Array<{ path: string; count: number }>;
};

type MetricsStoreDependencies = {
  production: () => boolean;
  query: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
  now: () => Date;
};

export function createUsageMetricsStore(options: Partial<MetricsStoreDependencies> = {}) {
  const dependencies: MetricsStoreDependencies = { production: isProductionIndexable,
    query: query => getDb().execute(query), now: () => new Date(), ...options };

  async function record(event: UsageEvent): Promise<boolean> {
    if (!dependencies.production()) return false;
    const valid = parseUsageEvent(event);
    if (!valid) return false;
    // A single atomic upsert stores the count, never a log entry for an individual visit.
    await dependencies.query(sql`INSERT INTO seo_usage_daily(day,event,path,source,count)
      VALUES(${usageDay(dependencies.now())}::date,${valid.name},${valid.path},${valid.source},1)
      ON CONFLICT(day,event,path,source) DO UPDATE SET count=seo_usage_daily.count+1`);
    return true;
  }

  async function summary(days = 30): Promise<UsageSummary> {
    const enabled = dependencies.production();
    const period = usagePeriod(days, dependencies.now());
    const events = new Map<UsageEventName, number>(usageEventNames.map(name => [name, 0]));
    const sources = new Map<UsageSource, number>(usageSources.map(source => [source, 0]));
    const paths = new Map<string, number>();
    const pageViews = new Map<string, number>();
    const interactions = new Map<string, number>();
    let total = 0;
    if (enabled) {
      const result = await dependencies.query(sql`SELECT event,source,path,sum(count)::text AS count
        FROM seo_usage_daily WHERE day>=${period.from}::date AND day<=${period.to}::date GROUP BY event,source,path`);
      for (const row of result.rows) {
        const event = parseUsageEvent({ name: row.event, path: row.path, source: row.source });
        const count = Number(row.count);
        if (!event || !Number.isFinite(count) || count <= 0) continue;
        total += count;
        events.set(event.name, (events.get(event.name) ?? 0) + count);
        sources.set(event.source, (sources.get(event.source) ?? 0) + count);
        paths.set(event.path, (paths.get(event.path) ?? 0) + count);
        const destination = event.name === 'page_view' ? pageViews : interactions;
        destination.set(event.path, (destination.get(event.path) ?? 0) + count);
      }
    }
    return { enabled, period, total, events: [...events].map(([name, count]) => ({ name, count })),
      sources: [...sources].map(([source, count]) => ({ source, count })),
      paths: [...paths].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 50),
      pageViews: [...pageViews].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 50),
      interactions: [...interactions].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 50) };
  }
  return { record, summary };
}

const store = createUsageMetricsStore();
export const getUsageSummary = store.summary;

/** Resolve only visible publications, including canonicalization of historical recipe slugs. */
export async function resolveUsagePath(path: string): Promise<string | null> {
  const valid = usagePath(path);
  if (!valid) return null;
  const [, localeName, section, slug] = valid.split('/');
  const locale = localeName as Locale;
  if (!section || section === 'o-serwisie' || section === 'plan') return valid;
  if (section === 'recipes') {
    const recipe = await publicRecipe(slug, locale);
    return recipe ? usagePath(getRecipeHref(recipe, locale)) : null;
  }
  if (!slug && (section === 'poradniki' || section === 'kolekcje')) return valid;
  if (section === 'poradniki') return guides.some(guide => getGuideHref(guide, locale) === valid) ? valid : null;
  return (await getPublicCollections(await publicRecipes(), locale)).some(collection => collection.path === valid) ? valid : null;
}

export class UsageRequestError extends Error {
  constructor(public readonly status: number) { super('INVALID_USAGE_REQUEST'); }
}

async function readEvent(request: Request): Promise<UsageEvent> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > usageBodyLimit)) throw new UsageRequestError(413);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new UsageRequestError(415);
  if (!request.body) throw new UsageRequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > usageBodyLimit) throw new UsageRequestError(413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  try {
    const event = parseUsageEvent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))));
    if (!event) throw new UsageRequestError(400);
    return event;
  } catch { throw new UsageRequestError(400); }
}

type UsageRequestDependencies = {
  production: () => boolean;
  resolvePath: (path: string) => Promise<string | null>;
  record: (event: UsageEvent) => Promise<boolean>;
};
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

/** No request headers or payloads are logged, persisted or reflected in responses. */
export async function handleUsageRequest(request: Request, options: Partial<UsageRequestDependencies> = {}): Promise<Response> {
  const dependencies: UsageRequestDependencies = { production: isProductionIndexable, resolvePath: resolveUsagePath, record: store.record, ...options };
  try {
    if (!dependencies.production()) return new Response(null, { status: 204, headers: responseHeaders });
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (origin !== PUBLIC_SITE_URL || new URL(request.url).origin !== PUBLIC_SITE_URL || (fetchSite && fetchSite !== 'same-origin')) throw new UsageRequestError(403);
    if (request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1' || isUsageBot(request.headers.get('user-agent'))) return new Response(null, { status: 204, headers: responseHeaders });
    const event = await readEvent(request);
    const path = await dependencies.resolvePath(event.path);
    if (!path) throw new UsageRequestError(404);
    const canonical = parseUsageEvent({ ...event, path });
    if (!canonical) throw new UsageRequestError(400);
    await dependencies.record(canonical);
    return new Response(null, { status: 204, headers: responseHeaders });
  } catch (error) {
    return new Response(null, { status: error instanceof UsageRequestError ? error.status : 503, headers: responseHeaders });
  }
}
