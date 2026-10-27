import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCreatorProfile, hasInterestClaim, rankCandidates, sourceIndependence, warsawDate, publicSourceUrl } from './ranking';
import type { RawCandidate } from './ranking';
const now = new Date('2026-10-04T08:00:00Z');
function candidate(): RawCandidate {
    return { dishKey: 'crispy rice salad', title: { pl: 'Sałatka z chrupiącym ryżem', en: 'Crispy rice salad' }, aliases: ['Crunchy rice salad'], rationale: 'Fresh interest across independent platforms.', sources: [
            { url: 'https://www.instagram.com/one/reel/post/', title: 'Crunchy salad', publisher: 'Creator One', platform: 'instagram', publishedAt: '2026-10-02', excerpt: 'This crispy rice salad is going viral this week.', interestEvidence: 'Creator describes a current viral salad.', independentKey: 'forged' },
            { url: 'https://www.tiktok.com/@two/video/1', title: 'Rice recipe', publisher: 'Creator Two', platform: 'tiktok', publishedAt: '2026-10-03', excerpt: 'Everyone is making the crunchy rice salad trend.', interestEvidence: 'New trending dish discussion.', independentKey: 'forged' },
            { url: 'https://food.example.com/rice', title: 'Salad trend', publisher: 'Food Publisher', platform: 'web', publishedAt: '2026-10-01', excerpt: 'The latest popular salad uses crispy roasted rice.', interestEvidence: 'Current trend coverage.', independentKey: 'forged' },
        ] };
}
const allowed = (c: RawCandidate) => c.sources.map(s => s.url);
test('Warsaw day is stable across both daylight saving transitions and UTC midnight', () => { assert.equal(warsawDate(new Date('2026-03-29T00:30:00Z')), '2026-03-29'); assert.equal(warsawDate(new Date('2026-03-29T01:30:00Z')), '2026-03-29'); assert.equal(warsawDate(new Date('2026-10-25T00:30:00Z')), '2026-10-25'); assert.equal(warsawDate(new Date('2026-10-25T01:30:00Z')), '2026-10-25'); assert.equal(warsawDate(new Date('2026-10-03T23:30:00Z')), '2026-10-04'); });
test('three fresh independent sources including social and a trend claim qualify', () => { const c = candidate(); const [result] = rankCandidates([c], allowed(c), [], 'run', now); assert.equal(result.eligible, true); assert.equal(result.score.independentSources, 3); assert.equal(result.score.platforms, 3); });
test('unknown citations, stale dates, future dates and duplicate copied sources do not qualify', () => { for (const mutation of [(c: RawCandidate) => c.sources[0].publishedAt = '2026-09-01', (c: RawCandidate) => c.sources[0].publishedAt = '2027-01-01', (c: RawCandidate) => c.sources[0].url = 'https://invented.example.com/post', (c: RawCandidate) => c.sources[0].excerpt = c.sources[1].excerpt]) {
    const c = candidate();
    const urls = allowed(c);
    mutation(c);
    assert.equal(rankCandidates([c], urls, [], 'run', now)[0].eligible, false);
} });
test('creator crossposts count once despite forged independent keys', () => { const c = candidate(); c.sources[0].url = 'https://www.instagram.com/two/reel/post/'; assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].eligible, false); });
test('a potrawa with an existing English name or alias is not regenerated', () => { const c = candidate(); const existing = [{ id: 'already', title: { pl: 'Inna nazwa', en: 'Crunchy rice salad' } }]; const r = rankCandidates([c], allowed(c), existing, 'run', now)[0]; assert.equal(r.eligible, false); assert.equal(r.duplicateRecipeId, 'already'); });
test('sources without an interest claim or social coverage are rejected', () => { const c = candidate(); for (const s of c.sources) {
    s.interestEvidence = '';
    s.excerpt = 'A fresh rice salad recipe with crisp vegetables.';
} assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].eligible, false); });
test('URL canonicalisation removes trackers and rejects internal destinations', () => { assert.equal(publicSourceUrl('https://food.example.com/a?utm_source=x&v=1#part'), 'https://food.example.com/a?v=1'); for (const url of ['http://food.example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://x.internal/a', 'https://user:pass@example.com/a'])
    assert.equal(publicSourceUrl(url), null); });
test('model publisher names cannot manufacture independent web origins', () => { const c = candidate(); c.sources[0].url = 'https://food.example.com/one'; c.sources[1].url = 'https://food.example.com/two'; assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].eligible, false); });
test('an invented interest summary cannot qualify an ordinary excerpt', () => { const c = candidate(); for (const source of c.sources)
    source.excerpt = 'A rice salad recipe with cucumber and dressing.'; assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].eligible, false); });
test('aliases group the same dish before counting evidence', () => { const c = candidate(); const other = structuredClone(c); other.dishKey = 'crunchy rice salad'; other.title = { pl: 'Inny tytuł', en: 'Rice plate' }; c.sources = c.sources.slice(0, 2); other.sources = other.sources.slice(2); const result = rankCandidates([c, other], [...allowed(c), ...allowed(other)], [], 'run', now); assert.equal(result.length, 1); assert.equal(result[0].eligible, true); });

test('ordinary white rice prose cannot qualify by matching a substring of hit',()=>{const c=candidate();for(const source of c.sources)source.excerpt='A recipe with white rice and cucumber in the kitchen.';assert.equal(rankCandidates([c],allowed(c),[],'run',now)[0].eligible,false);});

test('real reel and watch URLs can use verified primary-page creator profiles', () => {
    const c = candidate();
    c.sources[0].url = 'https://instagram.com/reel/real-post/';
    c.sources[0].verifiedCreator = 'https://www.instagram.com/one/';
    c.sources[1].url = 'https://youtube.com/watch?v=real-video';
    c.sources[1].verifiedCreator = 'https://youtube.com/channel/UC_OtherCreator';
    const [result] = rankCandidates([c], allowed(c), [], 'run', now);
    assert.equal(result.eligible, true);
    assert.equal(result.score.independentSources, 3);
    delete c.sources[0].verifiedCreator;
    delete c.sources[1].verifiedCreator;
    assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].score.independentSources, 1);
});

test('only canonical social profile URLs can supply a verified creator identity', () => {
    assert.equal(canonicalCreatorProfile('https://www.instagram.com/Real.Chef/?utm_source=x'), 'https://instagram.com/real.chef/');
    assert.equal(canonicalCreatorProfile('https://youtube.com/channel/UC_Cooking123'), 'https://youtube.com/channel/UC_Cooking123');
    for (const url of ['https://instagram.com/reel/post/', 'https://youtube.com/watch?v=123', 'https://youtube.com.evil.invalid/@chef', 'https://tiktok.com/@chef/video/123', 'https://localhost/@chef', 'javascript:alert(1)']) assert.equal(canonicalCreatorProfile(url), null);
});

test('reserved platform routes cannot become URL-derived creator identities', () => {
    for (const url of ['https://instagram.com/accounts/help', 'https://instagram.com/about/help', 'https://instagram.com/direct/post', 'https://pinterest.com/business/help', 'https://pinterest.com/login/help']) {
        assert.equal(sourceIndependence(url, url.includes('instagram') ? 'instagram' : 'pinterest'), 'social:unverified');
    }
    assert.equal(sourceIndependence('https://tiktok.com/@real.chef/video/123', 'tiktok'), 'creator:realchef');
    assert.equal(sourceIndependence('https://instagram.com/___/reel/x', 'instagram'), 'social:unverified');
    assert.equal(sourceIndependence('https://tiktok.com/@___/video/123', 'tiktok', 'https://tiktok.com/@___'), 'social:unverified');
});

test('a page-verified interest claim can qualify outside the short quote, while a model summary cannot', () => {
    const c = candidate();
    for (const item of c.sources) item.excerpt = 'A rice salad with crisp vegetables and a citrus dressing.' + item.platform;
    c.sources[0].interestEvidence = 'This salad is taking social media by storm.';
    assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].eligible, false);
    c.sources[0].verifiedInterest = true;
    assert.equal(rankCandidates([c], allowed(c), [], 'run', now)[0].eligible, true);
    for (const phrase of ['Everyone’s making this dish.', 'The recipe is taking TikTok by storm.', 'Ten przepis podbija internet.', 'Sałatka robi furorę.']) assert(hasInterestClaim(phrase));
    assert.equal(hasInterestClaim('Use white rice and hit the timer button.'), false);
});

test('research survives alias grouping and reports stale or duplicate evidence without hiding candidates', () => {
    const c = candidate();
    c.research = { foundSources: 5, verifiedSources: 3, issues: [{ url: 'https://instagram.com/reel/no-date/', platform: 'instagram', reason: 'date_unknown' }] };
    const other = structuredClone(c);
    other.dishKey = 'crunchy rice salad';
    other.research = { foundSources: 2, verifiedSources: 1, issues: [{ url: 'https://allrecipes.com/missing', platform: 'web', reason: 'quote_missing' }] };
    other.sources = [structuredClone(c.sources[0])];
    c.sources[2].publishedAt = '2026-09-01';
    const [result] = rankCandidates([c, other], [...allowed(c), ...allowed(other)], [], 'run', now);
    assert.equal(result.research?.foundSources, 7);
    assert.equal(result.research?.verifiedSources, 2);
    assert.deepEqual(new Set(result.research?.issues.map(issue => issue.reason)), new Set(['date_unknown', 'quote_missing', 'date_stale', 'duplicate_source']));
    assert.equal(result.eligible, false);
    const [empty] = rankCandidates([{ ...candidate(), sources: [] }], [], [], 'run', now);
    assert.match(empty.rejectionReason!, /trzy niezależne/);
    assert.match(empty.rejectionReason!, /społecznościowego/);
    assert.match(empty.rejectionReason!, /zainteresowania/);
});

test('non-Latin canonical names retain the candidate through its meaningful English title', () => {
    for (const dishKey of ['脆米沙拉', 'クリスピーライスサラダ']) {
        const c = candidate(); c.dishKey = dishKey;
        const result = rankCandidates([c], allowed(c), [], 'run', now);
        assert.equal(result.length, 1);
        assert.equal(result[0].dishKey, 'crispy rice salad');
        assert.equal(result[0].score.independentSources, 3);
        assert.equal(result[0].eligible, true);
        assert.equal(result[0].sources.length, 3);
    }
});

test('distinct literal CJK excerpts keep their identity while an exact copied quote is still deduplicated', () => {
    const c = candidate();
    const excerpts = ['香脆米饭沙拉配新鲜黄瓜和浓郁柠檬酱汁', '酥脆米粒与蔬菜搭配制作清爽美味的沙拉', '金黄米饭加入黄瓜和香草制作爽口的沙拉'];
    c.sources.forEach((item, index) => { item.excerpt = excerpts[index]; item.interestEvidence = ''; });
    c.sources[0].interestEvidence = 'This salad is going viral this week.';
    c.sources[0].verifiedInterest = true;
    const [distinct] = rankCandidates([c], allowed(c), [], 'run', now);
    assert.equal(distinct.sources.length, 3);
    assert.equal(distinct.eligible, true);
    c.sources[1].excerpt = c.sources[0].excerpt;
    const [copied] = rankCandidates([c], allowed(c), [], 'run', now);
    assert.equal(copied.sources.length, 2);
    assert.equal(copied.eligible, false);
    assert(copied.research?.issues.some(issue => issue.reason === 'duplicate_quote'));
});
