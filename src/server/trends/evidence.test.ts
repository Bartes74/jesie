import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrendEvidence } from '@/lib/trend-types';
import { approvedSourceUrl, sourceDocument, verifyEvidence } from './evidence';
import { rankCandidates, type RawCandidate } from './ranking';

const date = '2026-10-04T06:00:00Z';
const now = new Date('2026-10-04T08:00:00Z');
const excerpt = 'A crisp rice salad with cucumber and a tangy dressing.';
function source(url: string, patch: Partial<TrendEvidence> = {}): TrendEvidence {
    return { url, title: 'Rice salad', publisher: 'Publisher', platform: 'web', publishedAt: date, excerpt, interestEvidence: '', independentKey: 'model-authored', ...patch };
}
function candidate(sources: TrendEvidence[]): RawCandidate {
    return { dishKey: 'crispy rice salad', title: { pl: 'Chrupiąca sałatka ryżowa', en: 'Crispy rice salad' }, aliases: [], rationale: 'Evidence under review.', sources };
}
function jsonLd(value: unknown) { return '<script type="application/ld+json">' + JSON.stringify(value) + '</script>'; }
function html(body = excerpt, publishedAt = date) {
    return `<meta property="article:published_time" content="${publishedAt}"><p>${body}</p>`;
}
function page(body: string) { return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } }); }
function youtubePlayerHtml(videoId: string, patch: Record<string, unknown> = {}) {
    const channelId = 'UCJFp8uSYCjXOMnkUyb3CQ3Q';
    return '<script>var ytInitialPlayerResponse = ' + JSON.stringify({
        videoDetails: { videoId, channelId, title: 'Crispy rice salad', shortDescription: excerpt },
        microformat: { playerMicroformatRenderer: { externalVideoId: videoId, canonicalUrl: 'https://www.youtube.com/shorts/' + videoId,
            externalChannelId: channelId, ownerProfileUrl: 'http://www.youtube.com/@RealChef', publishDate: date, uploadDate: date, ...patch } },
    }) + '; console.log("this script is never evaluated");</script>';
}

test('canonical Schema.org type IRIs retain explicitly matching primary publication and creator metadata', () => {
    const url = 'https://instagram.com/reel/primary/';
    for (const type of ['https://schema.org/VideoObject', 'http://schema.org/Article', 'https://schema.org/Recipe/']) {
        const doc = sourceDocument(jsonLd({ '@type': type, url, datePublished: date, description: excerpt, author: { url: 'https://instagram.com/real.chef/' } }), url);
        assert.equal(doc.publishedAt, '2026-10-04T06:00:00.000Z');
        assert.equal(doc.verifiedCreator, 'https://instagram.com/real.chef/');
        assert(doc.text.includes('crisp rice salad'));
    }
    const unsupported = sourceDocument(jsonLd({ '@type': 'https://schema.org.evil.invalid/Article', url, datePublished: date }), url);
    assert.equal(unsupported.publishedAt, null);
});

test('all explicitly matching primary records contribute metadata, while related records stay excluded', () => {
    const url = 'https://instagram.com/reel/primary/';
    const doc = sourceDocument(jsonLd({ '@graph': [
        { '@type': 'Recipe', url },
        { '@type': 'Article', mainEntityOfPage: { '@id': url }, datePublished: date, headline: excerpt, author: { url: 'https://instagram.com/real.chef/' } },
        { '@type': 'VideoObject', url: 'https://instagram.com/reel/related/', uploadDate: '2026-10-05', description: 'Unrelated viral recommendation.', author: { url: 'https://instagram.com/unrelated/' } },
    ] }), url);
    assert.equal(doc.publishedAt, '2026-10-04T06:00:00.000Z');
    assert.equal(doc.verifiedCreator, 'https://instagram.com/real.chef/');
    assert(doc.text.includes('crisp rice salad'));
    assert.equal(doc.text.includes('unrelated viral'), false);
});

test('conflicting matching primary dates preserve the oldest first publication instead of a newer upload', () => {
    const url = 'https://allrecipes.com/primary';
    const doc = sourceDocument(jsonLd({ '@graph': [
        { '@type': 'VideoObject', url, uploadDate: date },
        { '@type': 'Recipe', url, datePublished: '2024-01-01' },
        { '@type': 'Article', url, datePublished: date },
    ] }), url);
    assert.equal(doc.publishedAt, '2024-01-01T00:00:00.000Z');
});

test('substantial literal CJK quotes qualify as evidence without whitespace word segmentation', async () => {
    const post = source('https://allrecipes.com/cjk', { excerpt: '香脆米饭沙拉配新鲜黄瓜和浓郁柠檬酱汁' });
    const accepted = await verifyEvidence([candidate([post])], [post.url], async () => page(html(post.excerpt)));
    assert.equal(accepted.verifiedSources, 1);
    assert.equal(accepted.issueCounts.quote_missing, undefined);
    for (const excerpt of ['香脆米饭', '12345678901234567890', 'Antidisestablishmentarianism']) {
        const short = await verifyEvidence([candidate([source(post.url, { excerpt })])], [post.url], async () => page(html(excerpt)));
        assert.equal(short.verifiedSources, 0);
        assert.equal(short.issueCounts.quote_missing, 1);
    }
    const fabricated = await verifyEvidence([candidate([post])], [post.url], async () => page(html('不同的沙拉配料和烹饪描述没有该引用文字')));
    assert.equal(fabricated.verifiedSources, 0);
    assert.equal(fabricated.issueCounts.quote_missing, 1);
});

test('creator-free Instagram reel uses only the primary JSON-LD author and linked profile identity', () => {
    const url = 'https://www.instagram.com/reel/current/?igsh=tracking';
    const body = jsonLd({ '@graph': [
        { '@type': 'VideoObject', url: 'https://instagram.com/reel/current/', uploadDate: date, author: { '@id': '#creator' }, description: excerpt },
        { '@type': 'Person', '@id': '#creator', url: 'https://www.tiktok.com/@differenthandle', sameAs: ['https://www.instagram.com/Real.Chef/', 'https://evil.invalid/profile'] },
        { '@type': 'VideoObject', url: 'https://instagram.com/reel/recommended/', uploadDate: '2026-10-03', author: { url: 'https://instagram.com/wrong/' } },
    ] });
    const doc = sourceDocument(body, url);
    assert.equal(doc.verifiedCreator, 'https://instagram.com/real.chef/');
    assert.equal(doc.publishedAt, '2026-10-04T06:00:00.000Z');
    assert(doc.text.includes('crisp rice salad'));
    const unrelated = sourceDocument(body, 'https://instagram.com/reel/unknown/');
    assert.equal(unrelated.publishedAt, null);
    assert.equal(unrelated.verifiedCreator, undefined);
});

test('YouTube watch author is verified by its matching video, never an unrelated author or post URL', () => {
    const url = 'https://www.youtube.com/watch?v=video123&si=tracking';
    const body = jsonLd({ '@type': 'VideoObject', url: 'https://youtube.com/watch?v=video123', uploadDate: date, author: { url: 'https://www.youtube.com/channel/UC_Cooking123' } });
    assert.equal(sourceDocument(body, url).verifiedCreator, 'https://youtube.com/channel/UC_Cooking123');
    const wrong = jsonLd({ '@type': 'VideoObject', url: 'https://youtube.com/watch?v=other', uploadDate: date, author: { url: 'https://youtube.com/@borrowed' } });
    assert.equal(sourceDocument(wrong, url).verifiedCreator, undefined);
    const unsafe = jsonLd({ '@type': 'VideoObject', url, uploadDate: date, author: { url: 'https://youtube.com/watch?v=not-a-profile', sameAs: ['https://127.0.0.1/private', 'https://youtube.com.evil.invalid/@forged'] } });
    assert.equal(sourceDocument(unsafe, url).verifiedCreator, undefined);
});

test('YouTube primary player JSON verifies the exact video, channel, literal description and original date without executing scripts', async () => {
    const videoId = 'xCwJoffOb0Y';
    const post = source('https://www.youtube.com/watch?v=' + videoId, { platform: 'youtube' });
    const body = youtubePlayerHtml(videoId);
    for (const url of [post.url, 'https://youtu.be/' + videoId, 'https://www.youtube.com/shorts/' + videoId]) {
        const doc = sourceDocument(body, url);
        assert.equal(doc.publishedAt, '2026-10-04T06:00:00.000Z');
        assert(doc.text.includes('crisp rice salad with cucumber'));
        assert.deepEqual(doc.creatorProfiles, ['https://youtube.com/@realchef', 'https://youtube.com/channel/UCJFp8uSYCjXOMnkUyb3CQ3Q']);
        assert.equal(doc.text.includes('this script is never evaluated'), false);
    }
    const accepted = await verifyEvidence([candidate([post])], [post.url], async () => page(body));
    assert.equal(accepted.verifiedSources, 1);
    assert.equal(accepted.issueCounts.creator_unknown, undefined);
    assert.equal(accepted.candidates[0].sources[0].verifiedCreator, 'https://youtube.com/@realchef');
    const stale = sourceDocument(html('', date) + youtubePlayerHtml(videoId, { publishDate: '2024-11-01T12:00:43-07:00' }), post.url);
    assert.equal(stale.publishedAt, '2024-11-01T19:00:43.000Z');
});

test('unrelated, malformed or unbound YouTube player data cannot supply primary evidence', () => {
    const videoId = 'xCwJoffOb0Y';
    const url = 'https://www.youtube.com/watch?v=' + videoId;
    for (const body of [
        youtubePlayerHtml('jyMKxchCLyM'),
        youtubePlayerHtml(videoId, { externalVideoId: 'jyMKxchCLyM' }),
        youtubePlayerHtml(videoId, { canonicalUrl: 'https://www.youtube.com/watch?v=jyMKxchCLyM' }),
        '<script>var ytInitialPlayerResponse = { invalid JSON }; alert("not executed");</script>',
        '<script>window.unrelated = ' + JSON.stringify({ videoDetails: { videoId, shortDescription: excerpt } }) + ';</script>',
    ]) {
        const doc = sourceDocument(body, url);
        assert.equal(doc.publishedAt, null);
        assert.equal(doc.verifiedCreator, undefined);
        assert.equal(doc.text.includes('crisp rice salad'), false);
    }
    const noDate = sourceDocument(youtubePlayerHtml(videoId, { publishDate: undefined, uploadDate: undefined }), url);
    assert.equal(noDate.publishedAt, null);
    const noChannel = sourceDocument(youtubePlayerHtml(videoId, { externalChannelId: 'UC_wrong', ownerProfileUrl: 'https://youtube.com/@forged' }), url);
    assert.equal(noChannel.verifiedCreator, undefined);
    const maliciousOwner = sourceDocument(youtubePlayerHtml(videoId, { ownerProfileUrl: 'http://youtube.com.evil.invalid/@forged' }), url);
    assert.equal(maliciousOwner.verifiedCreator, 'https://youtube.com/channel/UCJFp8uSYCjXOMnkUyb3CQ3Q');
});

test('an identity-less JSON-LD embed cannot certify the creator of a creator-free social post', async () => {
    const post = source('https://instagram.com/reel/real-post/', { platform: 'instagram' });
    const body = html() + jsonLd({ '@type': 'VideoObject', uploadDate: date, description: excerpt, author: { url: 'https://instagram.com/related.creator/' } });
    const result = await verifyEvidence([candidate([post])], [post.url], async () => page(body));
    assert.equal(result.verifiedSources, 1);
    assert.equal(result.candidates[0].sources[0].verifiedCreator, undefined);
    assert.equal(result.candidates[0].sources[0].publisher, 'instagram.com');
    assert.equal(result.issueCounts.creator_unknown, 1);
    assert.equal(rankCandidates(result.candidates, [post.url], [], 'run', now)[0].score.independentSources, 0);
});

test('a related identity-less embed cannot lend its fresh date or description to the primary page', async () => {
    const post = source('https://allrecipes.com/old-or-undated');
    const claim = 'This new dish is the latest viral cooking trend.';
    const body = '<main><article><p>' + excerpt + '</p><aside>'
        + jsonLd({ '@type': 'Article', datePublished: date, description: claim }) + '</aside></article></main>';
    const doc = sourceDocument(body, post.url);
    assert.equal(doc.publishedAt, null);
    assert.equal(doc.text.includes('latest viral'), false);
    const result = await verifyEvidence([candidate([post])], [post.url], async () => page(body));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.verifiedSources, 0);
    assert.equal(result.issueCounts.date_unknown, 1);
    assert.equal(result.candidates[0].research?.foundSources, 1);
    assert.equal(rankCandidates(result.candidates, [post.url], [], 'run', now).length, 1);
    const dated = body + jsonLd({ '@type': 'Article', url: post.url, datePublished: '2024-01-01', description: excerpt });
    assert.equal(sourceDocument(dated, post.url).publishedAt, '2024-01-01T00:00:00.000Z');
});

test('body recommendation metadata cannot lend a publication date or popularity description', async () => {
    const post = source('https://allrecipes.com/undated-page');
    const claim = 'This new dish is the latest viral cooking trend.';
    const content = '<main><article><p>' + excerpt + '</p></article><aside><meta itemprop="datePublished" content="' + date
        + '"><meta name="description" content="' + claim + '"></aside></main>';
    for (const body of [content, '<html><head><title>Rice salad</title></head><body>' + content + '</body></html>']) {
        const doc = sourceDocument(body, post.url);
        assert.equal(doc.publishedAt, null);
        assert.equal(doc.text.includes('latest viral'), false);
        const result = await verifyEvidence([candidate([post])], [post.url], async () => page(body));
        assert.equal(result.verifiedSources, 0);
        assert.equal(result.issueCounts.date_unknown, 1);
        assert.equal(result.candidates.length, 1);
    }
});

test('TikTok embedded metadata must match the source post ID before its creator or timestamp is used', () => {
    const body = '<script type="application/json">' + JSON.stringify({ posts: [
        { id: '999', createTime: String(Date.parse(date) / 1000), desc: excerpt, author: { uniqueId: 'wrong' } },
        { id: '123', createTime: String(Date.parse(date) / 1000), desc: excerpt, author: { uniqueId: 'Real.Chef' } },
    ] }) + '</script>';
    const doc = sourceDocument(body, 'https://www.tiktok.com/@real.chef/video/123');
    assert.equal(doc.verifiedCreator, 'https://tiktok.com/@real.chef');
    assert.equal(doc.publishedAt, '2026-10-04T06:00:00.000Z');
    assert(doc.text.includes('crisp rice salad'));
    const missing = sourceDocument(body, 'https://www.tiktok.com/@real.chef/video/456');
    assert.equal(missing.verifiedCreator, undefined);
    assert.equal(missing.publishedAt, null);
});

test('sameAs links deduplicate verified crossposts with different platform handles', async () => {
    const posts = [source('https://instagram.com/reel/one/', { platform: 'instagram' }), source('https://youtube.com/watch?v=two', { platform: 'youtube', excerpt: 'Another crisp rice dish with fresh vegetables and dressing.' }), source('https://foodandwine.com/coverage', { excerpt: 'This crispy rice salad is going viral in home kitchens.' })];
    const author = { url: 'https://tiktok.com/@differenthandle', sameAs: ['https://instagram.com/sharedchef/'] };
    const result = await verifyEvidence([candidate(posts)], posts.map(item => item.url), async input => {
        const url = String(input);
        const item = posts.find(post => post.url === url)!;
        return page(html(item.excerpt) + jsonLd({ '@type': 'VideoObject', url, uploadDate: date, author }));
    });
    const [ranked] = rankCandidates(result.candidates, posts.map(item => item.url), [], 'run', now);
    assert.equal(result.verifiedSources, 3);
    assert.equal(ranked.score.independentSources, 2);
    assert.equal(ranked.eligible, false);
    assert.equal(ranked.sources[0].verifiedCreator, ranked.sources[1].verifiedCreator);
});

test('one-way primary author profile links deduplicate a crosspost with only native metadata', async () => {
    const posts = [
        source('https://instagram.com/reel/one/', { platform: 'instagram' }),
        source('https://tiktok.com/@differenthandle/video/123', { platform: 'tiktok', excerpt: 'Another crisp rice dish with fresh vegetables and dressing.' }),
        source('https://foodandwine.com/rice', { excerpt: 'This crispy rice salad is going viral in home kitchens.' }),
    ];
    const result = await verifyEvidence([candidate(posts)], posts.map(item => item.url), async input => {
        const item = posts.find(post => post.url === String(input))!;
        if (item.platform === 'instagram') return page(html(item.excerpt) + jsonLd({ '@type': 'VideoObject', url: item.url, author: { url: 'https://instagram.com/sharedchef/', sameAs: ['https://tiktok.com/@differenthandle'] } }));
        if (item.platform === 'tiktok') return page('<script type="application/json">' + JSON.stringify({ post: { id: '123', createTime: String(Date.parse(date) / 1000), desc: item.excerpt, author: { uniqueId: 'differenthandle' } } }) + '</script>');
        return page(html(item.excerpt));
    });
    assert.equal(result.verifiedSources, 3);
    assert.equal(result.candidates[0].sources[0].verifiedCreator, result.candidates[0].sources[1].verifiedCreator);
    const [ranked] = rankCandidates(result.candidates, posts.map(item => item.url), [], 'run', now);
    assert.equal(ranked.score.independentSources, 2);
    assert.equal(ranked.eligible, false);
});

test('a proven sameAs profile also deduplicates a creator-bearing post without embedded author data', async () => {
    const posts = [
        source('https://instagram.com/reel/one/', { platform: 'instagram' }),
        source('https://tiktok.com/@differenthandle/video/123', { platform: 'tiktok', excerpt: 'Another crisp rice dish with fresh vegetables and dressing.' }),
        source('https://foodandwine.com/rice', { excerpt: 'This crispy rice salad is going viral in home kitchens.' }),
    ];
    const result = await verifyEvidence([candidate(posts)], posts.map(item => item.url), async input => {
        const item = posts.find(post => post.url === String(input))!;
        return page(html(item.excerpt) + (item.platform === 'instagram' ? jsonLd({ '@type': 'VideoObject', url: item.url, author: { url: 'https://instagram.com/sharedchef/', sameAs: ['https://tiktok.com/@differenthandle'] } }) : ''));
    });
    assert.equal(result.verifiedSources, 3);
    assert.equal(result.candidates[0].sources[0].verifiedCreator, result.candidates[0].sources[1].verifiedCreator);
    const [ranked] = rankCandidates(result.candidates, posts.map(item => item.url), [], 'run', now);
    assert.equal(ranked.score.independentSources, 2);
    assert.equal(ranked.eligible, false);
});

test('primary author alias groups remain bounded to 32 canonical profile URLs per document', () => {
    const url = 'https://instagram.com/reel/bounded/';
    const profiles = Array.from({ length: 40 }, (_, index) => 'https://instagram.com/creator' + index + '/');
    const doc = sourceDocument(jsonLd({ '@type': 'VideoObject', url, author: { sameAs: profiles } }), url);
    assert.equal(doc.creatorProfiles?.length, 32);
    assert.equal(new Set(doc.creatorProfiles).size, 32);
});

test('a literal interest claim elsewhere on the page can qualify without altering the short excerpt', async () => {
    const claim = 'This salad is taking social media by storm.';
    const posts = [source('https://instagram.com/reel/one/', { platform: 'instagram', interestEvidence: claim }), source('https://seriouseats.com/rice', { excerpt: 'Rice with crisp vegetables and a light citrus dressing.' }), source('https://foodandwine.com/rice', { excerpt: 'A tangy dressing complements crunchy grains and cucumber.' })];
    const result = await verifyEvidence([candidate(posts)], posts.map(item => item.url), async input => {
        const item = posts.find(post => post.url === String(input))!;
        return page(html(item.excerpt + ' ' + claim) + jsonLd({ '@type': 'VideoObject', url: item.url, author: { url: 'https://instagram.com/one/' } }));
    });
    assert.equal(result.candidates[0].sources[0].interestEvidence, claim);
    assert.equal(result.candidates[0].sources[0].verifiedInterest, true);
    assert.equal(result.candidates[0].sources[0].excerpt, excerpt);
    assert.equal(result.candidates[0].sources[0].publisher, 'one');
    assert.equal(rankCandidates(result.candidates, posts.map(item => item.url), [], 'run', now)[0].eligible, true);
});

test('model-authored proof markers and ungrounded popularity metrics are discarded', async () => {
    const post = source('https://instagram.com/reel/no-author/', { platform: 'instagram', verifiedCreator: 'https://instagram.com/forged/', verifiedInterest: true, interestEvidence: 'This viral salad has 1000000 views.' });
    const result = await verifyEvidence([candidate([post])], [post.url], async () => page(html()));
    const accepted = result.candidates[0].sources[0];
    assert.equal(accepted.verifiedCreator, undefined);
    assert.equal(accepted.verifiedInterest, undefined);
    assert.equal(accepted.interestEvidence, '');
    assert.equal(result.issueCounts.interest_unverified, 1);
    assert.equal(result.issueCounts.creator_unknown, 1);
    const [ranked] = rankCandidates(result.candidates, [post.url], [], 'run', now);
    assert.equal(ranked.score.independentSources, 0);
    assert.match(ranked.rejectionReason!, /zainteresowania/);
});

test('a popularity keyword inside an unrelated word is never a literal verified interest claim', async () => {
    const post = source('https://allrecipes.com/ordinary', { interestEvidence: 'viral' });
    const result = await verifyEvidence([candidate([post])], [post.url], async () => page(html(excerpt + ' A note mentions antiviral research.')));
    assert.equal(result.verifiedSources, 1);
    assert.equal(result.issueCounts.interest_unverified, 1);
    assert.equal(result.candidates[0].sources[0].verifiedInterest, undefined);
    assert.equal(result.candidates[0].sources[0].interestEvidence, '');
    assert.match(rankCandidates(result.candidates, [post.url], [], 'run', now)[0].rejectionReason!, /zainteresowania/);
});

test('related widgets cannot supply a quoted trend claim or supplemental popularity evidence', async () => {
    const claim = 'Everyone is making the newest viral dinner trend.';
    const url = 'https://allrecipes.com/ordinary-rice';
    const body = html('') + '<main><article><p>' + excerpt + '</p></article><aside><div>Recommended dish</div><p>' + claim + '</p></aside></main>';
    const raw = candidate([source(url, { interestEvidence: claim })]);
    const result = await verifyEvidence([raw], [url], async () => page(body));
    assert.equal(result.verifiedSources, 1);
    assert.equal(result.candidates[0].sources[0].interestEvidence, '');
    assert.equal(result.candidates[0].sources[0].verifiedInterest, undefined);
    assert.equal(result.issueCounts.interest_unverified, 1);
    raw.sources[0].excerpt = claim;
    raw.sources[0].interestEvidence = '';
    const sidebar = await verifyEvidence([raw], [url], async () => page(body));
    assert.equal(sidebar.verifiedSources, 0);
    assert.equal(sidebar.issueCounts.quote_missing, 1);
    assert.equal(rankCandidates(sidebar.candidates, [url], [], 'run', now)[0].eligible, false);
    const nested = '<article><p>' + excerpt + '</p><div class="related-recipes"><div>Recipe links</div><p>' + claim + '</p></div></article>';
    assert.equal(sourceDocument(html('') + nested, url).text.includes('newest viral'), false);
});

test('incomplete candidates retain precise source diagnostics and unknown model dates may use proven page metadata', async () => {
    const posts = [
        source('https://unsupported.invalid/article'), source('https://allrecipes.com/uncited'), source('https://allrecipes.com/unavailable'),
        source('https://allrecipes.com/no-date'), source('https://allrecipes.com/mismatch'), source('https://allrecipes.com/no-quote'),
        source('https://allrecipes.com/valid', { publishedAt: '', publisher: '' }),
    ];
    const urls = posts.filter(item => !item.url.endsWith('/uncited')).map(item => item.url);
    const result = await verifyEvidence([candidate(posts), { ...candidate([]), dishKey: 'another dish' }], urls, async input => {
        const url = String(input);
        if (url.endsWith('/unavailable')) return new Response('', { status: 403 });
        if (url.endsWith('/no-date')) return page('<p>' + excerpt + '</p>');
        if (url.endsWith('/mismatch')) return page(html(excerpt, '2026-10-03'));
        if (url.endsWith('/no-quote')) return page(html('Different recipe text without the submitted quote.'));
        return page(html());
    });
    assert.equal(result.candidates.length, 2);
    assert.equal(result.submittedSources, 7);
    assert.equal(result.verifiedSources, 1);
    assert.deepEqual(result.issueCounts, { unsupported_domain: 1, uncited_url: 1, unavailable: 1, date_unknown: 1, date_mismatch: 1, quote_missing: 1 });
    assert.deepEqual(result.candidates[0].research?.foundSources, 7);
    assert.equal(result.candidates[0].research?.issues.length, 6);
    assert.equal(result.candidates[0].sources[0].publishedAt, '2026-10-04T06:00:00.000Z');
    assert.equal(result.candidates[0].sources[0].publisher, 'allrecipes.com');
    assert.deepEqual(result.candidates[1].research, { foundSources: 0, verifiedSources: 0, issues: [] });
});

test('unsafe redirects, unsupported content and oversized streams stay bounded and visible in diagnostics', async () => {
    for (const [expected, response] of [
        ['unsafe_redirect', () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } })],
        ['unsupported_content', () => new Response('{}', { headers: { 'content-type': 'application/json' } })],
        ['response_too_large', () => page('x'.repeat(2 * 1024 * 1024 + 1))],
    ] as const) {
        const post = source('https://allrecipes.com/protected');
        let reads = 0;
        const result = await verifyEvidence([candidate([post])], [post.url], async (_input, init) => {
            reads++;
            assert.equal(init?.redirect, 'manual');
            assert.equal(init?.credentials, 'omit');
            assert.equal(new Headers(init?.headers).has('authorization'), false);
            assert(init?.signal instanceof AbortSignal);
            return response();
        });
        assert.equal(reads, 1);
        assert.equal(result.verifiedSources, 0);
        assert.equal(result.issueCounts[expected], 1);
        assert.equal(result.candidates[0].sources.length, 0);
    }
});

test('normal large recipe and social documents remain accepted below the 2 MiB decoded limit', async () => {
    const post = source('https://allrecipes.com/large-public-page');
    const body = html() + '<script type="application/json">' + JSON.stringify({ padding: 'x'.repeat(1600000) }) + '</script>';
    const result = await verifyEvidence([candidate([post])], [post.url], async () => page(body));
    assert.equal(result.verifiedSources, 1);
    assert.equal(result.issueCounts.response_too_large, undefined);
    const tooLargeHeader = await verifyEvidence([candidate([post])], [post.url], async () => new Response(body, {
        headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024 + 1) },
    }));
    assert.equal(tooLargeHeader.verifiedSources, 0);
    assert.equal(tooLargeHeader.issueCounts.response_too_large, 1);
});

test('expanded publisher hosts are exact and unlisted subdomains or lookalikes remain blocked', () => {
    for (const url of ['https://www.simplyrecipes.com/rice', 'https://cooking.nytimes.com/recipes/rice', 'https://www.thekitchn.com/rice', 'https://youtu.be/video']) assert(approvedSourceUrl(url));
    for (const url of ['https://internal.allrecipes.com/rice', 'https://allrecipes.com.evil.invalid/rice', 'https://simplyrecipes.com:8443/rice', 'https://user@foodnetwork.com/rice', 'http://allrecipes.com/rice']) assert.equal(approvedSourceUrl(url), null);
});

test('redirects cannot manufacture independent web publishers, while hostname equivalents stay allowed', async () => {
    const posts = [source('https://foodandwine.com/redirected'), source('https://allrecipes.com/redirected')];
    let reads = 0;
    const result = await verifyEvidence([candidate(posts)], posts.map(item => item.url), async () => {
        reads++;
        return new Response(null, { status: 302, headers: { location: 'https://delish.com/common-recipe' } });
    });
    assert.equal(reads, 2);
    assert.equal(result.verifiedSources, 0);
    assert.equal(result.issueCounts.unsafe_redirect, 2);
    const equivalent = source('https://allrecipes.com/initial');
    const accepted = await verifyEvidence([candidate([equivalent])], [equivalent.url], async input => String(input) === equivalent.url
        ? new Response(null, { status: 302, headers: { location: 'https://www.allrecipes.com/current' } }) : page(html()));
    assert.equal(accepted.verifiedSources, 1);
    assert.equal(accepted.issueCounts.unsafe_redirect, undefined);
});

test('verification gives every candidate a page within 24 unique reads and four concurrent requests', async () => {
    const posts = Array.from({ length: 25 }, (_, index) => source('https://allrecipes.com/article-' + index));
    const candidates = [candidate(posts.slice(0, 12)), candidate(posts.slice(12, 24)), candidate(posts.slice(24))];
    const reads: string[] = []; let active = 0; let peak = 0;
    const result = await verifyEvidence(candidates, posts.map(item => item.url), async input => {
        reads.push(String(input)); active++; peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return page(html());
    });
    assert.equal(reads.length, 24);
    assert.deepEqual(reads.slice(0, 3), [posts[0].url, posts[12].url, posts[24].url]);
    assert.equal(new Set(reads).size, 24);
    assert(peak <= 4);
    assert.equal(result.submittedSources, 25);
    assert.equal(result.verifiedSources, 24);
    assert.equal(result.issueCounts.verification_budget, 1);
    assert.equal(result.candidates[2].research?.verifiedSources, 1);
    assert.deepEqual(result.candidates[2].research?.issues, []);
    assert(result.candidates.slice(0, 2).some(candidate => candidate.research?.issues.some(issue => issue.reason === 'verification_budget')));
});

test('round-robin verification skips repeated and uncited URLs without starving later recipe leads', async () => {
    const early = source('https://allrecipes.com/shared');
    const later = source('https://foodandwine.com/later');
    const uncited = source('https://delish.com/uncited');
    const candidates = [candidate([uncited, early, early]), candidate([early]), candidate([later])];
    const reads: string[] = [];
    const result = await verifyEvidence(candidates, [early.url, later.url], async input => {
        reads.push(String(input));
        return page(html());
    });
    assert.deepEqual(reads, [early.url, later.url]);
    assert.equal(result.issueCounts.uncited_url, 1);
    assert.equal(result.issueCounts.verification_budget, undefined);
    assert.equal(result.candidates[2].research?.verifiedSources, 1);
});
