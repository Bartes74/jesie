import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes } from './recipes';
import { toPublicRecipe } from './recipe-presentation';
import { buildLlmsText, buildRecipeFeed, homeStructuredData, isProductionIndexable, pageMetadata, publicRobots, recipeMetadata, recipeSitemapEntries, recipeStructuredData, serializeJsonLd } from './seo';

function publication() {
  return toPublicRecipe({ ...structuredClone(recipes[0]), publication: { datePublished: '2026-09-01T04:00:00.000Z', dateModified: '2026-10-10T12:30:00.000Z', author: 'jesie.pl' } });
}

test('only production deployment permits indexing; a production build never opens previews', () => {
  assert.equal(isProductionIndexable({ VERCEL_ENV: 'production', NODE_ENV: 'production' }), true);
  assert.equal(isProductionIndexable({ VERCEL_ENV: 'preview', NODE_ENV: 'production', SEO_INDEXING_ENABLED: 'true' }), false);
  assert.equal(isProductionIndexable({ VERCEL_ENV: 'development', NODE_ENV: 'production' }), false);
  assert.equal(isProductionIndexable({ NODE_ENV: 'production' }), false);
  assert.equal(isProductionIndexable({ NODE_ENV: 'production', SEO_INDEXING_ENABLED: 'true' }), true);
  assert.equal(isProductionIndexable({ NODE_ENV: 'development', SEO_INDEXING_ENABLED: 'true' }), false);
  assert.deepEqual(publicRobots(false), { index: false, follow: false });
  assert.deepEqual(publicRobots(true), { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 });
});

test('metadata uses canonical production host and strips state and tracking parameters', () => {
  const metadata = pageMetadata({ locale: 'en', title: 'Lemon tagliatelle', description: 'Cook step by step.', path: '/en/recipes/lemon-tagliatelle?servings=8&utm_source=test#method', languages: { 'en-GB': '/en/recipes/lemon-tagliatelle' }, image: { url: '/images/lemon-pasta.webp', width: 1200, height: 630, alt: 'Pasta with basil' }, type: 'article', datePublished: '2026-09-01T04:00:00Z', author: 'jesie.pl' });
  assert.equal(metadata.alternates?.canonical, 'https://www.jesie.pl/en/recipes/lemon-tagliatelle');
  assert.deepEqual(metadata.title, { absolute: 'Lemon tagliatelle | jesie.pl' });
  assert.deepEqual(metadata.alternates?.languages, { 'en-GB': 'https://www.jesie.pl/en/recipes/lemon-tagliatelle' });
  const encoded = JSON.stringify(metadata);
  assert(encoded.includes('en_GB'));
  assert(encoded.includes('summary_large_image'));
  assert(encoded.includes('Pasta with basil'));
  assert(!encoded.includes('utm_source'));
});

test('editorial SEO overrides stay localized while structured data reflects the actual dish', () => {
  const recipe = { ...publication(), seo: { title: { pl: 'Kremowy makaron cytrynowy', en: 'Creamy lemon pasta' }, description: { pl: 'Przepis z przelicznikiem porcji.', en: 'A recipe with adjustable servings.' }, keywords: { pl: ['makaron', 'obiad'], en: ['pasta', 'dinner'] } } };
  assert.deepEqual(recipeMetadata(recipe, 'pl').title, { absolute: 'Kremowy makaron cytrynowy | jesie.pl' });
  assert.equal(recipeMetadata(recipe, 'en').description, 'A recipe with adjustable servings.');
  const entity = recipeStructuredData(recipe, 'pl')['@graph'].find(item => item['@type'] === 'Recipe')! as Record<string, unknown>;
  assert.equal(entity.name, recipe.title.pl);
  assert.equal(entity.description, recipe.description.pl);
  assert.equal(entity.keywords, 'makaron, obiad');
});

test('Recipe schema uses base servings, expanded metric amounts and real publication history', () => {
  const recipe = publication();
  const original = structuredClone(recipe);
  const data = recipeStructuredData(recipe, 'pl');
  const entity = data['@graph'].find(item => item['@type'] === 'Recipe')! as Record<string, unknown>;
  assert.equal(entity.recipeYield, '4 porcje');
  assert.equal(entity.totalTime, 'PT25M');
  // Prep is the remainder after cooking, so the pair matches the dependency-timed total.
  assert.equal(entity.cookTime, 'PT10M');
  assert.equal(entity.datePublished, '2026-09-01T04:00:00.000Z');
  assert.equal(entity.dateModified, '2026-10-10T12:30:00.000Z');
  assert.equal(entity.prepTime, 'PT15M');
  assert(!('nutrition' in entity));
  assert(!('aggregateRating' in entity));
  assert(!('suitableForDiet' in entity));
  assert.equal((entity.image as string[]).length, 3);
  assert((entity.recipeIngredient as string[]).some(line => line.includes('400 g') && line.includes('tagliatelle')));
  assert((entity.recipeIngredient as string[]).some(line => line.includes('20–30 ml') && line.includes('Zacznij od dolnej granicy')));
  const instructions = entity.recipeInstructions as Array<Record<string, string>>;
  assert(instructions.some(step => step.text.includes('Dodaj 400 g tagliatelle')));
  assert(instructions.every(step => !step.text.includes('{{') && step.url.includes('#step-')));
  assert.deepEqual(recipe, original);
});

test('recipe metadata and structured copy format long waits without rewriting source or ISO duration', () => {
  const recipe = publication();
  recipe.description = { pl: 'Gotowe po 90 minutach.', en: 'Ready after 90 minutes.' };
  recipe.seo = { description: { pl: 'Przygotowanie w 120 minut.', en: 'Prepare in 120 minutes.' } };
  recipe.ingredients[0].note = { pl: 'Namaczaj przez 60 minut.', en: 'Soak for 60 minutes.' };
  recipe.steps[0].text = { pl: 'Duś 180–240 minut. Sprawdzaj co 30 minut.', en: 'Braise for 180–240 minutes. Check every 30 minutes.' };
  recipe.times.total = 1440;
  const original = structuredClone(recipe);

  for (const locale of ['pl', 'en'] as const) {
    const entity = recipeStructuredData(recipe, locale)['@graph'].find(item => item['@type'] === 'Recipe')! as Record<string, unknown>;
    assert.equal(entity.totalTime, 'PT1440M');
    assert.equal(entity.description, locale === 'pl' ? 'Gotowe po 1 godz. 30 min.' : 'Ready after 1 hr 30 min.');
    assert.equal(recipeMetadata(recipe, locale).description, locale === 'pl' ? 'Przygotowanie w 2 godz.' : 'Prepare in 2 hr.');
    assert((entity.recipeIngredient as string[])[0].includes(locale === 'pl' ? 'Namaczaj przez 1 godz.' : 'Soak for 1 hr.'));
    assert.equal((entity.recipeInstructions as Array<{ text: string }>)[0].text, locale === 'pl' ? 'Duś 3–4 godz. Sprawdzaj co 30 minut.' : 'Braise for 3–4 hr. Check every 30 minutes.');
    assert(buildRecipeFeed([recipe], locale).includes(locale === 'pl' ? 'Gotowe po 1 godz. 30 min.' : 'Ready after 1 hr 30 min.'));
  }
  assert.deepEqual(recipe, original);
});

test('schema excludes photo atlases and private notes and keeps stable recipe identity after slug edits', () => {
  const recipe = publication();
  recipe.photos = { ingredients: {}, steps: { pasta: { src: '/images/steps-lemon-pasta.webp', columns: 2, rows: 3, index: 1, alt: { pl: 'Makaron', en: 'Pasta' } } } };
  const before = recipeStructuredData(recipe, 'pl');
  recipe.slug.pl = 'nowy-adres-makaronu';
  const after = recipeStructuredData(recipe, 'pl');
  const entity = before['@graph'].find(item => item['@type'] === 'Recipe')! as Record<string, unknown>;
  const changed = after['@graph'].find(item => item['@type'] === 'Recipe')! as Record<string, unknown>;
  assert.equal(entity['@id'], changed['@id']);
  assert.notEqual(entity.url, changed.url);
  assert(!JSON.stringify(before).includes('/images/steps-lemon-pasta.webp'));
  assert(!JSON.stringify(before).includes('provenance'));
});

test('JSON-LD safely round-trips editorial text that could break out of a script', () => {
  const payload = { title: '</script><script>alert("x")</script>', description: 'A&B\u2028C\u2029D' };
  const serialized = serializeJsonLd(payload);
  assert(!serialized.includes('<'));
  assert(!serialized.includes('&'));
  assert(!serialized.includes('\u2028'));
  assert.deepEqual(JSON.parse(serialized), payload);
});

test('sitemap includes recipe images and only existing language equivalents with actual modification dates', () => {
  const recipe = publication();
  const entries = recipeSitemapEntries([recipe]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].lastModified, '2026-10-10T12:30:00.000Z');
  assert(entries[0].images?.[0].startsWith('https://www.jesie.pl/media/recipes/'));
  assert.equal(entries[0].alternates?.languages?.['en-GB'], entries[1].url);
  recipe.slug.en = '';
  const polishOnly = recipeSitemapEntries([recipe]);
  assert.equal(polishOnly.length, 1);
  assert.deepEqual(polishOnly[0].alternates?.languages, { pl: polishOnly[0].url, 'x-default': polishOnly[0].url });
  assert.equal(entries[1].alternates?.languages?.['x-default'], entries[0].url);
  const legacy = toPublicRecipe(structuredClone(recipes[0]));
  assert(!('lastModified' in recipeSitemapEntries([legacy])[0]));
});

test('RSS escapes editorial content and uses original publication date rather than update date', () => {
  const recipe = publication();
  recipe.title.pl = 'Makaron <pyszny> & "łatwy"';
  recipe.description.pl = 'Opis & składniki\u0000';
  const xml = buildRecipeFeed([recipe], 'pl');
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert(xml.includes('Makaron &lt;pyszny&gt; &amp; &quot;łatwy&quot;'));
  assert(xml.includes('<pubDate>Tue, 01 Sep 2026 04:00:00 GMT</pubDate>'));
  assert(xml.includes('<lastBuildDate>Sat, 10 Oct 2026 12:30:00 GMT</lastBuildDate>'));
  assert(!xml.includes('\u0000'));
  assert(!xml.includes('provenance'));
  assert(!buildRecipeFeed([toPublicRecipe(recipes[0])], 'pl').includes('<pubDate>'));
});

test('home schema publishes only site identity and a representative dish image', () => {
  const data = homeStructuredData('en', publication());
  assert.equal(data['@graph'].find(node => node['@type'] === 'WebSite')?.name, 'jesie.pl');
  const encoded = JSON.stringify(data);
  assert(encoded.includes('en-GB'));
  assert(encoded.includes('1600'));
  assert(!encoded.includes('aggregateRating'));
});

test('RSS combines guides and recipes in publication order and retains stable identity on updates', () => {
  const recipe = publication();
  const guide = { id: 'https://www.jesie.pl/#guide-servings-pl', path: '/pl/poradniki/porcje', title: 'Jak przeliczać porcje', description: 'Poradnik', datePublished: '2026-10-01T04:00:00Z', dateModified: '2026-10-01T04:00:00Z' };
  const xml = buildRecipeFeed([recipe], 'pl', [guide]);
  assert(xml.indexOf('<title>Jak przeliczać porcje</title>') < xml.indexOf(`<title>${recipe.title.pl}</title>`));
  assert(xml.includes('<guid isPermaLink="false">https://www.jesie.pl/#guide-servings-pl</guid>'));
  const updated = { ...recipe, publication: { ...recipe.publication!, dateModified: '2026-10-12T04:00:00Z' } };
  const updatedFeed = buildRecipeFeed([updated], 'pl', [guide]);
  assert(updatedFeed.indexOf('<title>Jak przeliczać porcje</title>') < updatedFeed.indexOf(`<title>${recipe.title.pl}</title>`));
});

test('x-default follows the Polish edition only when it exists', () => {
  const both = pageMetadata({ locale: 'en', title: 'Guides', description: 'Help.', path: '/en/poradniki', languages: { pl: '/pl/poradniki', 'en-GB': '/en/poradniki' } });
  assert.equal(both.alternates?.languages?.['x-default' as 'pl'], 'https://www.jesie.pl/pl/poradniki');
  const englishOnly = pageMetadata({ locale: 'en', title: 'Guides', description: 'Help.', path: '/en/poradniki', languages: { 'en-GB': '/en/poradniki' } });
  assert(!('x-default' in (englishOnly.alternates?.languages ?? {})));
});

test('Recipe schema omits a time split it cannot keep consistent and mirrors visible questions as FAQPage', () => {
  const recipe = publication();
  recipe.times = { ...recipe.times, cooking: 0 };
  const entity = recipeStructuredData(recipe, 'pl')['@graph'].find(item => item['@type'] === 'Recipe')! as Record<string, unknown>;
  assert(!('prepTime' in entity) && !('cookTime' in entity));
  assert(!recipeStructuredData(recipe, 'pl')['@graph'].some(item => item['@type'] === 'FAQPage'));
  const asked = { ...recipe, seo: { questions: [{ id: 'q', question: { pl: 'Czy można zamrozić?', en: '' }, answer: { pl: 'Tak, do miesiąca.', en: '' } }] } } as typeof recipe;
  const faq = recipeStructuredData(asked, 'pl')['@graph'].find(item => item['@type'] === 'FAQPage') as Record<string, unknown> | undefined;
  assert.deepEqual(faq?.mainEntity, [{ '@type': 'Question', name: 'Czy można zamrozić?', acceptedAnswer: { '@type': 'Answer', text: 'Tak, do miesiąca.' } }]);
  assert(!recipeStructuredData(asked, 'en')['@graph'].some(item => item['@type'] === 'FAQPage'));
});

test('llms.txt lists only the given published content per edition with absolute links', () => {
  const recipe = publication();
  const guide = { path: '/pl/poradniki/porcje', title: 'Porcje [poradnik]', description: 'Jak\n przeliczać.' };
  const text = buildLlmsText([recipe], { pl: { collections: [], guides: [guide] }, en: { collections: [], guides: [] } }, { pl: 'Opis\n redakcji.', en: 'Editorial summary.' });
  assert(text.startsWith('# jesie.pl\n\n> Opis redakcji. / Editorial summary.\n'));
  assert(text.includes(`- [${recipe.title.pl}](https://www.jesie.pl${'/pl/recipes/'}`));
  assert(text.includes(`(https://www.jesie.pl/en/recipes/`));
  assert(text.includes('- [Porcje poradnik](https://www.jesie.pl/pl/poradniki/porcje): Jak przeliczać.'));
  assert(!text.includes('## Kolekcje'));
});
