import 'server-only';
import type { TrendEvidence, TrendPlatform, TrendResearch } from '@/lib/trend-types';
import { sourceDomains } from '@/lib/trend-sources';
import { canonicalCreatorProfile, publicSourceUrl, platformFor, type RawCandidate } from './ranking';
export { sourceDomains } from '@/lib/trend-sources';

export function approvedSourceUrl(value: string) {
    const normal = publicSourceUrl(value);
    if (!normal) return null;
    const host = new URL(normal).hostname;
    return sourceDomains.some(domain => host === domain || host === `www.${domain}` || host === `m.${domain}`) ? normal : null;
}
function entities(text: string) {
    return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[entity] ?? entity))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
        .replace(/&#x([a-f\d]+);/gi, (_, code) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)));
}
function normaliseQuote(value: string) {
    return entities(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function validDate(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function canonicalPage(value: string): string | null {
    const normal = publicSourceUrl(value);
    if (!normal) return null;
    const url = new URL(normal);
    url.hostname = url.hostname.replace(/^(?:www|m)\./, '');
    url.pathname = url.pathname.replace(/\/$/, '');
    if (platformFor(normal) !== 'web') for (const key of ['igsh', 'igshid', 'si', 'share_id', 'share_app_id']) url.searchParams.delete(key);
    return url.href;
}
function attribute(tag: string, name: string) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i'));
    return match ? entities(match[2]) : null;
}
function primaryVisibleText(html: string) {
    const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    let visible = ''; let cursor = 0; let blockedTag: string | null = null; let blockedDepth = 0;
    for (const match of clean.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
        const tag = match[1].toLowerCase();
        const closing = match[0].startsWith('</');
        if (!blockedTag) visible += clean.slice(cursor, match.index);
        if (blockedTag) {
            if (tag === blockedTag) {
                if (closing) blockedDepth--;
                else if (!match[0].endsWith('/>')) blockedDepth++;
                if (!blockedDepth) blockedTag = null;
            }
        } else if (!closing && (['aside', 'nav', 'footer', 'header'].includes(tag)
            || (['div', 'section'].includes(tag) && /\b(?:related|recommended|recommendations|sidebar|suggested|popular-posts)\b/i.test(`${attribute(match[0], 'class') ?? ''} ${attribute(match[0], 'id') ?? ''}`)))) {
            blockedTag = tag; blockedDepth = 1;
        } else visible += match[0];
        cursor = match.index! + match[0].length;
    }
    if (!blockedTag) visible += clean.slice(cursor);
    const primary = visible.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
        ?? visible.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? visible;
    return primary.replace(/<[^>]+>/g, ' ');
}
type SourceDocument = { publishedAt: string | null; dates: string[]; text: string; verifiedCreator?: string; creatorProfiles?: string[] };
const maxSourceBytes = 2 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function youtubeVideoId(value: string): string | null {
    const normal = approvedSourceUrl(value);
    if (!normal || platformFor(normal) !== 'youtube') return null;
    const url = new URL(normal);
    const id = url.hostname === 'youtu.be' ? url.pathname.split('/')[1]
        : url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)\/?$/)?.[1];
    return typeof id === 'string' && /^[a-z0-9_-]{11}$/i.test(id) ? id : null;
}
/** Extract a literal JSON object from YouTube's primary player assignment without evaluating JavaScript. */
function youtubePlayer(script: string): Record<string, unknown> | null {
    const assignment = script.match(/^\s*(?:var\s+)?ytInitialPlayerResponse\s*=\s*(\{)/);
    if (!assignment) return null;
    const start = assignment[0].length - 1;
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < script.length; index++) {
        const character = script[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) {
            try { return object(JSON.parse(script.slice(start, index + 1))); } catch { return null; }
        }
    }
    return null;
}

/** Primary page metadata takes precedence. Related articles supply neither dates nor authors. */
export function sourceDocument(html: string, sourceUrl?: string): SourceDocument {
    let publishedAt: string | null = null;
    const metadata: string[] = [];
    const descriptions: string[] = [];
    const metaDates = new Map<string, string>();
    // Body microdata may describe a recommendation; only document-head metadata belongs to this page.
    const documentPrefix = html.split(/<(?:body|main|article|aside|nav|footer)\b/i, 1)[0];
    const metadataHtml = documentPrefix.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? documentPrefix;
    for (const match of metadataHtml.matchAll(/<meta\b[^>]*>/gi)) {
        const tag = match[0];
        const property = attribute(tag, 'property') ?? attribute(tag, 'name') ?? attribute(tag, 'itemprop');
        const value = attribute(tag, 'content');
        if (!value) continue;
        if (property && ['description', 'og:description', 'twitter:description'].includes(property)) metadata.push(value);
        if (property && ['article:published_time', 'og:published_time', 'datePublished', 'pubdate', 'publish-date'].includes(property)) {
            const date = validDate(value);
            if (date && !metaDates.has(property)) metaDates.set(property, date);
        }
    }
    for (const name of ['article:published_time', 'og:published_time', 'datePublished', 'pubdate', 'publish-date']) {
        const date = metaDates.get(name);
        if (date) { publishedAt = date; break; }
    }
    const records: Record<string, unknown>[] = [];
    const youtubePlayers: Record<string, unknown>[] = [];
    let visited = 0;
    function collect(value: unknown, depth = 0) {
        if (depth > 12 || ++visited > 4096 || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(item => collect(item, depth + 1)); return; }
        const record = value as Record<string, unknown>;
        records.push(record);
        for (const child of Object.values(record)) if (child && typeof child === 'object') collect(child, depth + 1);
    }
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (sourceUrl && youtubeVideoId(sourceUrl)) {
            const player = youtubePlayer(script[2]);
            if (player) youtubePlayers.push(player);
        }
        if (!/type\s*=\s*["']application\/(?:ld\+)?json["']/i.test(script[1])) continue;
        try { collect(JSON.parse(script[2])); } catch { /* Embedded data is never executed. */ }
    }
    const articleTypes = new Set(['Article', 'NewsArticle', 'BlogPosting', 'Recipe', 'VideoObject', 'SocialMediaPosting']);
    const articleRecords = records.filter(record => {
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
        return types.some(type => typeof type === 'string' && articleTypes.has(type.match(/^https?:\/\/schema\.org\/([a-z]+)\/?$/i)?.[1] ?? type));
    });
    const primary = sourceUrl ? canonicalPage(sourceUrl) : null;
    const matches = articleRecords.filter(record => {
        const entity = record.mainEntityOfPage;
        const entityUrl = typeof entity === 'string' ? entity : entity && typeof entity === 'object' ? ((entity as Record<string, unknown>)['@id'] ?? (entity as Record<string, unknown>).url) : null;
        return primary && [record.url, record['@id'], entityUrl].some(value => typeof value === 'string' && canonicalPage(value) === primary);
    });
    const sole = articleRecords.length === 1 ? articleRecords[0] : null;
    const primaryRecords = matches.length ? matches : !sourceUrl && sole && !sole.url && !sole['@id'] && !sole.mainEntityOfPage ? [sole] : [];
    if (!publishedAt && primaryRecords.length) {
        const publicationDates = primaryRecords.map(record => validDate(record.datePublished)).filter((date): date is string => Boolean(date));
        const uploadDates = primaryRecords.map(record => validDate(record.uploadDate)).filter((date): date is string => Boolean(date));
        // Conflicting primary records cannot make an older publication appear newly published.
        publishedAt = (publicationDates.length ? publicationDates : uploadDates).sort()[0] ?? null;
    }
    for (const record of primaryRecords) for (const key of ['description', 'headline', 'caption', 'articleBody']) if (typeof record[key] === 'string') descriptions.push(record[key] as string);

    function authorProfiles(value: unknown, depth = 0): string[] {
        if (!value || depth > 4) return [];
        if (Array.isArray(value)) return value.flatMap(item => authorProfiles(item, depth + 1));
        if (typeof value === 'string') {
            const profile = canonicalCreatorProfile(value);
            if (profile) return [profile];
            const referenced = records.find(record => record['@id'] === value && (record.url || record.sameAs));
            return referenced ? authorProfiles(referenced, depth + 1) : [];
        }
        if (typeof value !== 'object') return [];
        const author = value as Record<string, unknown>;
        return [author.url, author.sameAs, author['@id']].flatMap(item => authorProfiles(item, depth + 1));
    }
    // A sole identity-less embed can describe a related video; it cannot certify this post's creator.
    let profiles = matches.flatMap(record => authorProfiles(record.author ?? record.creator));
    const youtubeId = sourceUrl ? youtubeVideoId(sourceUrl) : null;
    if (youtubeId) for (const player of youtubePlayers) {
        const details = object(player.videoDetails);
        const microformat = object(object(player.microformat)?.playerMicroformatRenderer);
        // Related player payloads cannot lend this page a date, description or creator.
        if (!details || !microformat || details.videoId !== youtubeId || microformat.externalVideoId !== youtubeId) continue;
        const canonicalUrl = microformat.canonicalUrl;
        if (typeof canonicalUrl === 'string' && youtubeVideoId(canonicalUrl) !== youtubeId) continue;
        const primaryDate = validDate(microformat.publishDate) ?? validDate(microformat.uploadDate);
        if (primaryDate && (!publishedAt || primaryDate < publishedAt)) publishedAt = primaryDate;
        for (const key of ['title', 'shortDescription']) if (typeof details[key] === 'string') descriptions.push(details[key] as string);
        const channelId = details.channelId;
        if (typeof channelId !== 'string' || !/^UC[a-z0-9_-]{22}$/i.test(channelId) || microformat.externalChannelId !== channelId) continue;
        profiles.push(`https://youtube.com/channel/${channelId}`);
        // YouTube's own owner URL may use HTTP; validation still accepts only a canonical HTTPS profile.
        const ownerUrl = typeof microformat.ownerProfileUrl === 'string' ? microformat.ownerProfileUrl.replace(/^http:\/\//i, 'https://') : '';
        const owner = canonicalCreatorProfile(ownerUrl);
        if (owner && platformFor(owner) === 'youtube') profiles.push(owner);
    }
    const videoId = sourceUrl && platformFor(sourceUrl) === 'tiktok' ? sourceUrl.match(/\/video\/(\d+)/)?.[1] : null;
    if (videoId) {
        const post = records.find(record => String(record.id ?? '') === videoId && /^\d{10}$/.test(String(record.createTime ?? '')));
        if (post) {
            if (!publishedAt) publishedAt = new Date(Number(post.createTime) * 1000).toISOString();
            if (typeof post.desc === 'string') descriptions.push(post.desc);
            const author = post.author;
            const username = typeof author === 'string' ? author : author && typeof author === 'object' ? (author as Record<string, unknown>).uniqueId : null;
            if (typeof username === 'string' && /^[a-z0-9._]{1,30}$/i.test(username)) {
                const profile = canonicalCreatorProfile(`https://tiktok.com/@${username}`);
                if (profile) profiles.push(profile);
            }
        }
    }
    // Linked social profiles use a stable choice, so crossposts sharing sameAs links count once.
    profiles = [...new Set(profiles)].sort().slice(0, 32);
    const visible = primaryVisibleText(html);
    return { publishedAt, dates: publishedAt ? [publishedAt.slice(0, 10)] : [], text: normaliseQuote(`${visible} ${metadata.join(' ')} ${descriptions.join(' ')}`), ...(profiles[0] ? { verifiedCreator: profiles[0], creatorProfiles: profiles } : {}) };
}

type PageResult = { document: SourceDocument; url: string; reason?: never } | { document: null; reason: string; url?: never };
async function readPage(url: string, fetcher: typeof fetch): Promise<PageResult> {
    let current = approvedSourceUrl(url);
    if (!current) return { document: null, reason: 'unsupported_domain' };
    const signal = AbortSignal.timeout(6000);
    for (let redirects = 0; redirects <= 2; redirects++) {
        const response: Response = await fetcher(current, { redirect: 'manual', signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'jesie.pl recipe research (+https://jesie.pl)' } });
        if (response.status >= 300 && response.status < 400) {
            const target = response.headers.get('location');
            await response.body?.cancel();
            let destination: string | null = null;
            try { destination = target ? approvedSourceUrl(new URL(target, current).href) : null; } catch { /* Malformed locations are not followed. */ }
            const sameWebOrigin = destination && new URL(destination).hostname.replace(/^(?:www|m)\./, '') === new URL(url).hostname.replace(/^(?:www|m)\./, '');
            if (!destination || platformFor(destination) !== platformFor(url) || (platformFor(url) === 'web' && !sameWebOrigin)) return { document: null, reason: 'unsafe_redirect' };
            current = destination;
            continue;
        }
        const reason = !response.ok ? 'unavailable' : !response.headers.get('content-type')?.includes('text/html') ? 'unsupported_content'
            : Number(response.headers.get('content-length') ?? 0) > maxSourceBytes ? 'response_too_large' : !response.body ? 'unavailable' : null;
        if (reason || !response.body) {
            await response.body?.cancel();
            return { document: null, reason: reason ?? 'unavailable' };
        }
        const reader = response.body.getReader();
        let total = 0;
        const chunks: Uint8Array[] = [];
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                total += part.value.byteLength;
                if (total > maxSourceBytes) {
                    await reader.cancel();
                    return { document: null, reason: 'response_too_large' };
                }
                chunks.push(part.value);
            }
        } finally { reader.releaseLock(); }
        return { document: sourceDocument(Buffer.concat(chunks).toString('utf8'), current), url: current };
    }
    return { document: null, reason: 'unavailable' };
}

export async function verifyEvidence(candidates: RawCandidate[], allowedUrls: string[], fetcher: typeof fetch = fetch) {
    const allowed = new Set(allowedUrls.map(approvedSourceUrl).filter(Boolean));
    const candidateUrls = candidates.map(candidate => [...new Set(candidate.sources.map(source => approvedSourceUrl(source.url)).filter((url): url is string => Boolean(url && allowed.has(url))))]);
    // Give every dish a first page before corroborating earlier dishes; the budget stays fixed.
    const urls: string[] = [];
    const seenUrls = new Set<string>();
    const rounds = Math.max(0, ...candidateUrls.map(list => list.length));
    for (let round = 0; round < rounds && urls.length < 24; round++) {
        for (const list of candidateUrls) {
            const url = list[round];
            if (!url || seenUrls.has(url)) continue;
            urls.push(url);
            seenUrls.add(url);
            if (urls.length === 24) break;
        }
    }
    const documents = new Map<string, PageResult>();
    const unavailable = new Set<TrendPlatform>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
        while (next < urls.length) {
            const url = urls[next++];
            try {
                const result = await readPage(url, fetcher);
                documents.set(url, result);
                if (!result.document) unavailable.add(platformFor(url));
            } catch {
                documents.set(url, { document: null, reason: 'unavailable' });
                unavailable.add(platformFor(url));
            }
        }
    }));
    // Primary authors' explicit sameAs links may be one-way; resolve at most 24 × 32 proven profiles.
    const creatorParents = new Map<string, string>();
    function creatorRoot(profile: string): string {
        const parent = creatorParents.get(profile);
        if (!parent) { creatorParents.set(profile, profile); return profile; }
        if (parent === profile) return profile;
        const root = creatorRoot(parent);
        creatorParents.set(profile, root);
        return root;
    }
    for (const result of documents.values()) {
        const profiles = result.document?.creatorProfiles ?? [];
        if (!profiles[0]) continue;
        for (const profile of profiles) {
            const first = creatorRoot(profiles[0]);
            const other = creatorRoot(profile);
            if (first !== other) creatorParents.set(first < other ? other : first, first < other ? first : other);
        }
    }
    const issueCounts: Record<string, number> = {};
    const submittedSources = candidates.reduce((count, candidate) => count + candidate.sources.length, 0);
    let verifiedSources = 0;
    const verified = candidates.map(candidate => {
        const research: TrendResearch = { foundSources: candidate.sources.length, verifiedSources: 0, issues: [] };
        const sources = candidate.sources.flatMap(source => {
            const url = approvedSourceUrl(source.url);
            const platform = url ? platformFor(url) : source.platform;
            const issue = (reason: string) => {
                research.issues.push({ url: url ?? source.url, platform, reason });
                issueCounts[reason] = (issueCounts[reason] ?? 0) + 1;
            };
            if (!url) { issue('unsupported_domain'); return []; }
            if (!allowed.has(url)) { issue('uncited_url'); return []; }
            const result = documents.get(url);
            if (!result) { issue('verification_budget'); return []; }
            if (!result.document) { issue(result.reason); return []; }
            const doc = result.document;
            let invalid = false;
            if (!doc.publishedAt) { issue('date_unknown'); invalid = true; }
            else if (source.publishedAt.trim()) {
                const date = Date.parse(source.publishedAt);
                if (!Number.isFinite(date) || !doc.dates.includes(new Date(date).toISOString().slice(0, 10))) { issue('date_mismatch'); invalid = true; }
            }
            const quote = normaliseQuote(source.excerpt);
            const primaryText = ` ${doc.text} `;
            const continuousCjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{M}\p{N}]+$/u.test(quote) && (quote.match(/\p{L}/gu)?.length ?? 0) >= 15;
            if (quote.length < 15 || (quote.split(/\s+/).length < 3 && !continuousCjk) || !/[\p{L}]/u.test(quote) || !primaryText.includes(` ${quote} `)) { issue('quote_missing'); invalid = true; }
            if (invalid || !doc.publishedAt) return [];
            const interest = normaliseQuote(source.interestEvidence);
            const groundedInterest = Boolean(interest && primaryText.includes(` ${interest} `));
            if (source.interestEvidence.trim() && !groundedInterest) issue('interest_unverified');
            const finalPage = new URL(result.url);
            const creatorSegment = finalPage.pathname.split('/').filter(Boolean)[0];
            const pathCreator = platform !== 'web' && creatorSegment ? canonicalCreatorProfile(`${finalPage.origin}/${creatorSegment}/`) : null;
            // A creator-bearing URL joins aliases only when a primary author already proved that profile.
            const verifiedCreator = doc.verifiedCreator ?? (pathCreator && creatorParents.has(pathCreator) ? pathCreator : undefined);
            if (platform !== 'web' && !verifiedCreator) issue('creator_unknown');
            const publisher = platform !== 'web' && verifiedCreator ? new URL(verifiedCreator).pathname.split('/').filter(Boolean).at(-1)! : new URL(url).hostname.replace(/^(?:www|m)\./, '');
            const accepted: TrendEvidence = { ...source, url, platform, publisher: publisher.slice(0, 120), publishedAt: doc.publishedAt, interestEvidence: groundedInterest ? source.interestEvidence : '' };
            delete accepted.verifiedCreator;
            delete accepted.verifiedInterest;
            if (verifiedCreator) accepted.verifiedCreator = creatorRoot(verifiedCreator);
            if (groundedInterest) accepted.verifiedInterest = true;
            research.verifiedSources++;
            verifiedSources++;
            return [accepted];
        });
        return { ...candidate, sources, research };
    });
    return { candidates: verified, unavailable: [...unavailable], issueCounts, submittedSources, verifiedSources };
}
