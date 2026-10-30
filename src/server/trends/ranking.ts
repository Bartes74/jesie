import type { Localised } from '@/lib/recipes';
import type { TrendCandidate, TrendEvidence, TrendPlatform, TrendResearch } from '@/lib/trend-types';
import type { RecipeDietId } from '@/lib/recipe-diet';
export const trendPlatforms: TrendPlatform[] = ['instagram', 'tiktok', 'pinterest', 'youtube', 'web'];
export function warsawDate(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
export function normaliseDish(value: string) { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, ' ').trim(); }
/** The dish name before its first accompaniment or style, e.g. "zupa cebulowa" in "Zupa cebulowa po francusku z grzankami". */
function dishHead(value: string) {
    const words = normaliseDish(value).split(' ').filter(Boolean);
    const end = words.findIndex(word => ['z', 'ze', 'w', 'we', 'po', 'na', 'with', 'in', 'on', 'and', 'i'].includes(word));
    return new Set(end === -1 ? words : words.slice(0, end));
}
/** "Francuska zupa cebulowa z grzankami" and "Zupa cebulowa z grzanką serową" share a two-word dish head in every common language. */
function sameDishHead(a: Localised, b: Localised) {
    const languages = (['pl', 'en'] as const).filter(language => a[language]?.trim() && b[language]?.trim());
    return languages.length > 0 && languages.every(language => {
        const [left, right] = [dishHead(a[language]), dishHead(b[language])].sort((x, y) => x.size - y.size);
        return left.size >= 2 && [...left].every(word => right.has(word));
    });
}
export function publicSourceUrl(value: string): string | null {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname === 'localhost' || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') || /\.(local|internal|localhost)$/.test(url.hostname))
            return null;
        url.hash = '';
        for (const name of [...url.searchParams.keys()])
            if (name.startsWith('utm_') || ['fbclid', 'gclid'].includes(name))
                url.searchParams.delete(name);
        return url.href;
    }
    catch {
        return null;
    }
}
export function platformFor(url: string): TrendPlatform { const host = new URL(url).hostname.replace(/^www\./, ''); if (host === 'instagram.com' || host.endsWith('.instagram.com'))
    return 'instagram'; if (host === 'tiktok.com' || host.endsWith('.tiktok.com'))
    return 'tiktok'; if (/^pinterest\.[a-z.]+$/.test(host) || host === 'pin.it')
    return 'pinterest'; if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be')
    return 'youtube'; return 'web'; }
/** Accept profiles, never a post, search page or arbitrary author-supplied website. */
export function canonicalCreatorProfile(value: string): string | null {
    const normal = publicSourceUrl(value);
    if (!normal) return null;
    const url = new URL(normal);
    const host = url.hostname.replace(/^(?:www|m)\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    const handle = parts[0];
    if (host === 'instagram.com' && parts.length === 1 && handle
        && /^[a-z0-9._]{1,30}$/i.test(handle)
        && !['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'share', 'about', 'legal', 'privacy', 'terms'].includes(handle.toLowerCase()))
        return `https://instagram.com/${handle.toLowerCase()}/`;
    if (host === 'tiktok.com' && parts.length === 1 && handle && /^@[a-z0-9._]{1,30}$/i.test(handle))
        return `https://tiktok.com/${handle.toLowerCase()}`;
    if (host === 'pinterest.com' && parts.length === 1 && handle && /^[a-z0-9_-]{1,64}$/i.test(handle)
        && !['pin', 'ideas', 'search', 'today', 'settings', 'login', 'business'].includes(handle.toLowerCase()) && !/^\d+$/.test(handle))
        return `https://pinterest.com/${handle.toLowerCase()}/`;
    if (host === 'youtube.com' && parts.length === 1 && handle && /^@[a-z0-9._-]{1,64}$/i.test(handle))
        return `https://youtube.com/${handle.toLowerCase()}`;
    if (host === 'youtube.com' && parts.length === 2 && ['channel', 'user', 'c'].includes(handle) && /^[a-z0-9_-]{3,100}$/i.test(parts[1]))
        return `https://youtube.com/${handle}/${handle === 'channel' ? parts[1] : parts[1].toLowerCase()}`;
    return null;
}
/** Independence comes from source identity, never model-authored publisher keys. */
export function sourceIndependence(value: string, platform: TrendPlatform, verifiedCreator?: string) {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    if (platform === 'web') {
        const labels = host.split('.');
        const count = /\.(co|com|org)\.[a-z]{2}$/.test(host) ? 3 : 2;
        return `web:${labels.slice(-count).join('.')}`;
    }
    function creatorIdentity(profileUrl: string) {
        const profile = new URL(profileUrl);
        const profileParts = profile.pathname.split('/').filter(Boolean);
        if (profile.hostname === 'youtube.com' && profileParts[0] === 'channel') return `creator:youtube-channel:${profileParts[1]}`;
        const handle = profileParts.at(-1)!.replace(/^@/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        return handle ? `creator:${handle}` : 'social:unverified';
    }
    const verified = verifiedCreator ? canonicalCreatorProfile(verifiedCreator) : null;
    if (verified) return creatorIdentity(verified);
    const first = parts[0];
    // Creator-bearing post paths still use the same profile validation as verified authors.
    const pathCreator = first ? canonicalCreatorProfile(`${url.origin}/${first}/`) : null;
    if (pathCreator) return creatorIdentity(pathCreator);
    // A post URL without creator identity is evidence, but cannot manufacture multiple independent creators.
    return 'social:unverified';
}
export type RawCandidate = {
    dishKey: string;
    title: Localised;
    aliases: string[];
    rationale: string;
    diet?: RecipeDietId;
    sources: TrendEvidence[];
    research?: TrendResearch;
};
export type ExistingDish = {
    id: string;
    title: Localised;
    aliases?: string[];
    diet?: RecipeDietId;
};
export function hasInterestClaim(value: string) {
    const normal = normaliseDish(value);
    return /\b(?:trend\w*|viral\w*|popular\w*|modn\w*|wirus\w*|buzz|sensac\w*)\b|everyone (?:is |s )?(?:making|cooking)|wszyscy (?:robia|gotuja)|taking (?:\w+ ){0,4}by storm|(?:internet|tiktok) famous|(?:breaking|broke) the internet|all over (?:social media|tiktok|instagram|your feed)|(?:latest|new) obsession|robi furore|podbij\w* (?:internet|siec|tiktok)|bije rekordy popularnosci|kulinarny hit/i.test(normal);
}
function mergeResearch(target: RawCandidate, other: RawCandidate) {
    // Conflicting base-ingredient descriptions do not establish a dietary category.
    if (target.diet !== other.diet) delete target.diet;
    target.research = {
        foundSources: (target.research?.foundSources ?? target.sources.length) + (other.research?.foundSources ?? other.sources.length),
        verifiedSources: (target.research?.verifiedSources ?? target.sources.length) + (other.research?.verifiedSources ?? other.sources.length),
        issues: [...(target.research?.issues ?? []), ...(other.research?.issues ?? [])],
    };
}
export function rankCandidates(raw: RawCandidate[], allowedUrls: string[], existing: ExistingDish[], runId: string, now = new Date()): TrendCandidate[] {
    const allowed = new Set(allowedUrls.map(publicSourceUrl).filter(Boolean));
    const oldest = now.getTime() - 14 * 86400000;
    const grouped = new Map<string, RawCandidate>();
    const namesFor = (candidate: RawCandidate) => [candidate.dishKey, candidate.title.pl, candidate.title.en, ...candidate.aliases].map(normaliseDish).filter(Boolean);
    for (const candidate of raw) {
        const key = normaliseDish(candidate.dishKey) || normaliseDish(candidate.title.en) || normaliseDish(candidate.title.pl);
        if (!key)
            continue;
        const names = new Set(namesFor(candidate));
        const matches = [...grouped.entries()].filter(([, group]) => namesFor(group).some(name => names.has(name)));
        if (!matches.length) {
            grouped.set(key, structuredClone(candidate));
            continue;
        }
        const [firstKey, prior] = matches[0];
        mergeResearch(prior, candidate);
        prior.sources.push(...candidate.sources);
        prior.aliases.push(candidate.dishKey, candidate.title.pl, candidate.title.en, ...candidate.aliases);
        for (const [otherKey, other] of matches.slice(1)) {
            mergeResearch(prior, other);
            prior.sources.push(...other.sources);
            prior.aliases.push(...namesFor(other));
            grouped.delete(otherKey);
        }
        grouped.set(firstKey, prior);
    }
    return [...grouped.entries()].slice(0, 20).map(([key, candidate], index) => {
        const seenUrls = new Set<string>();
        const excerpts = new Set<string>();
        const sources: TrendEvidence[] = [];
        const issues = [...(candidate.research?.issues ?? [])];
        for (const item of candidate.sources) {
            const url = publicSourceUrl(item.url);
            const date = Date.parse(item.publishedAt);
            const excerpt = item.excerpt.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            const reason = !url ? 'unsupported_domain' : !allowed.has(url) ? 'uncited_url' : seenUrls.has(url) ? 'duplicate_source'
                : !Number.isFinite(date) ? 'date_unknown' : date < oldest ? 'date_stale' : date > now.getTime() + 3600000 ? 'date_future'
                : item.excerpt.length < 15 || !item.publisher.trim() ? 'quote_missing' : excerpts.has(excerpt) ? 'duplicate_quote' : null;
            if (reason || !url) {
                issues.push({ url: url ?? item.url, platform: url ? platformFor(url) : item.platform, reason: reason ?? 'unsupported_domain' });
                continue;
            }
            const platform = platformFor(url);
            const verifiedCreator = canonicalCreatorProfile(item.verifiedCreator ?? '') ?? undefined;
            const independentKey = sourceIndependence(url, platform, verifiedCreator);
            sources.push({ ...item, verifiedCreator, excerpt: item.excerpt.split(/\s+/).slice(0, 20).join(' '), url, platform, independentKey, publishedAt: new Date(date).toISOString(), interestEvidence: item.interestEvidence.slice(0, 500) });
            seenUrls.add(url);
            excerpts.add(excerpt);
        }
        const names = [key, normaliseDish(candidate.title.pl), normaliseDish(candidate.title.en), ...candidate.aliases.map(normaliseDish)].filter(Boolean);
        const exact = existing.find(d => [normaliseDish(d.title.pl), normaliseDish(d.title.en), ...(d.aliases ?? []).map(normaliseDish)].some(name => names.includes(name)));
        const wordSet = new Set(names.join(' ').split(' '));
        const similar = existing.find(d => { const words = new Set(normaliseDish(`${d.title.pl} ${d.title.en}`).split(' ')); const shared = [...words].filter(w => w.length > 3 && wordSet.has(w)).length; return shared >= 2 && shared / Math.min(words.size, wordSet.size) >= .65 || sameDishHead(d.title, candidate.title); });
        const independentSources = new Set(sources.map(s => s.independentKey).filter(key => key !== 'social:unverified')).size;
        const social = sources.some(s => s.platform !== 'web' && s.independentKey !== 'social:unverified');
        // Interest must be grounded in a quoted textual claim, never an invented numeric metric.
        const interest = sources.some(s => hasInterestClaim(s.excerpt) || (s.verifiedInterest === true && hasInterestClaim(s.interestEvidence)));
        const gaps: string[] = [];
        if (exact) gaps.push('Potrawa znajduje się już w książce lub kolejce redakcyjnej.');
        if (independentSources < 3) gaps.push('Potrzebne są trzy niezależne, aktualne źródła.');
        if (!social) gaps.push('Brakuje aktualnego materiału społecznościowego.');
        if (!interest) gaps.push('Nie potwierdzono aktualnego zainteresowania.');
        if (!exact && similar) gaps.push('Podobieństwo do istniejącego przepisu wymaga sprawdzenia.');
        const rejectionReason = gaps.length ? gaps.join(' ') : null;
        return { id: `${runId}-${index}`, runId, dishKey: key, title: candidate.title, aliases: [...new Set(candidate.aliases)].slice(0, 12), rationale: candidate.rationale, ...(candidate.diet ? { diet: candidate.diet } : {}), sources, eligible: !rejectionReason, rejectionReason, duplicateRecipeId: exact?.id ?? similar?.id ?? null, ambiguous: !exact && Boolean(similar), score: { independentSources, newestAt: sources.reduce((date, s) => s.publishedAt > date ? s.publishedAt : date, ''), platforms: new Set(sources.map(s => s.platform)).size }, selected: false, research: { foundSources: candidate.research?.foundSources ?? candidate.sources.length, verifiedSources: sources.length, issues } };
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score.independentSources - a.score.independentSources || b.score.newestAt.localeCompare(a.score.newestAt) || b.score.platforms - a.score.platforms || a.dishKey.localeCompare(b.dishKey));
}
