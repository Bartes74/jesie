import type { Metadata, MetadataRoute } from 'next';
import { formatRecipeDurationText } from './recipe-duration-text';
import { categories, getRecipeHref, type Locale } from './recipes';
import type { PublicRecipe } from './recipe-presentation';
import { formatIngredientAmount, renderStepText } from './quantities';
import { formatServingCount } from './locale-format';
import { getRecipeImageVariants } from './recipe-image-variants';

export const PUBLIC_SITE_URL = 'https://www.jesie.pl';
export const SITE_NAME = 'jesie.pl';
export const PUBLIC_LOCALES: readonly Locale[] = ['pl', 'en'];

/** Never infer an indexable site from a production build on a preview host. */
export function isProductionIndexable(env: { VERCEL_ENV?: string; NODE_ENV?: string; SEO_INDEXING_ENABLED?: string } = process.env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === 'production';
  return env.NODE_ENV === 'production' && env.SEO_INDEXING_ENABLED === 'true';
}

export function absoluteUrl(path: string): string { return new URL(path, PUBLIC_SITE_URL).toString(); }
export function languageTag(locale: Locale): 'pl' | 'en-GB' { return locale === 'pl' ? 'pl' : 'en-GB'; }

/** Polish is the site's default edition; x-default points at it only when that edition exists. */
export function withDefaultLanguage(languages: Record<string, string>): Record<string, string> {
  return languages.pl ? { ...languages, 'x-default': languages.pl } : languages;
}

export function publicRobots(indexable = isProductionIndexable()): Metadata['robots'] {
  return {
    index: indexable,
    follow: indexable,
    ...(indexable ? { 'max-image-preview': 'large' as const, 'max-snippet': -1, 'max-video-preview': -1 } : {}),
  };
}

type PageMetadataOptions = {
  locale: Locale;
  title: string;
  description: string;
  path: string;
  image?: { url: string; width: number; height: number; alt: string };
  languages?: Partial<Record<'pl' | 'en-GB', string>>;
  type?: 'website' | 'article';
  datePublished?: string;
  dateModified?: string;
  author?: string;
};

export function pageMetadata(options: PageMetadataOptions): Metadata {
  const canonical = new URL(options.path, PUBLIC_SITE_URL);
  canonical.search = '';
  canonical.hash = '';
  const url = canonical.toString();
  const title = options.title.includes(SITE_NAME) ? options.title : `${options.title} | ${SITE_NAME}`;
  const images = options.image ? [{ ...options.image, url: absoluteUrl(options.image.url) }] : undefined;
  const languages = options.languages ? withDefaultLanguage(Object.fromEntries(Object.entries(options.languages).map(([language, path]) => [language, absoluteUrl(path)]))) : undefined;
  return {
    title: { absolute: title },
    description: options.description,
    alternates: { canonical: url, ...(languages ? { languages } : {}) },
    robots: publicRobots(),
    ...(options.author ? { authors: [{ name: options.author, ...(options.author === SITE_NAME ? { url: PUBLIC_SITE_URL } : {}) }] } : {}),
    openGraph: {
      title,
      description: options.description,
      url,
      siteName: SITE_NAME,
      locale: options.locale === 'pl' ? 'pl_PL' : 'en_GB',
      ...(images ? { images } : {}),
      ...(options.type === 'article' ? {
        type: 'article' as const,
        ...(options.datePublished ? { publishedTime: options.datePublished } : {}),
        ...(options.dateModified ? { modifiedTime: options.dateModified } : {}),
        ...(options.author ? { authors: [options.author] } : {}),
      } : { type: 'website' as const }),
    },
    twitter: { card: 'summary_large_image', title, description: options.description, ...(images ? { images } : {}) },
  };
}

export function recipeLocales(recipe: PublicRecipe): Locale[] {
  return PUBLIC_LOCALES.filter(locale => Boolean(recipe.slug[locale]?.trim() && recipe.title[locale]?.trim() && recipe.description[locale]?.trim()));
}

export function recipeLanguages(recipe: PublicRecipe): Partial<Record<'pl' | 'en-GB', string>> {
  return Object.fromEntries(recipeLocales(recipe).map(locale => [languageTag(locale), getRecipeHref(recipe, locale)]));
}

export function recipeMetadata(recipe: PublicRecipe, locale: Locale): Metadata {
  const image = getRecipeImageVariants(recipe).social;
  return pageMetadata({
    locale,
    title: recipe.seo?.title?.[locale]?.trim() || recipe.title[locale],
    description: formatRecipeDurationText(recipe.seo?.description?.[locale]?.trim() || recipe.description[locale], locale),
    path: getRecipeHref(recipe, locale),
    languages: recipeLanguages(recipe),
    image: { ...image, alt: recipe.imageAlt[locale] },
    type: 'article',
    datePublished: recipe.publication?.datePublished,
    dateModified: recipe.publication?.dateModified,
    author: recipe.publication?.author || SITE_NAME,
  });
}

/** Script text is inert even if editorial strings contain a closing script tag. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function organizationStructuredData() {
  // Google requires a raster logo; logo.png is rendered from logo.svg.
  return { '@type': 'Organization', '@id': `${PUBLIC_SITE_URL}/#organization`, name: SITE_NAME, url: PUBLIC_SITE_URL, logo: { '@type': 'ImageObject', url: absoluteUrl('/logo.png'), width: 512, height: 512 } };
}

export function homeStructuredData(locale: Locale, featured?: PublicRecipe, collectionImage?: { url: string; width: number; height: number }) {
  const url = absoluteUrl(`/${locale}`);
  const image = collectionImage ?? (featured ? getRecipeImageVariants(featured).landscape : undefined);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organizationStructuredData(),
      { '@type': 'WebSite', '@id': `${PUBLIC_SITE_URL}/#website`, url: PUBLIC_SITE_URL, name: SITE_NAME, inLanguage: ['pl', 'en-GB'], publisher: { '@id': `${PUBLIC_SITE_URL}/#organization` } },
      { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: locale === 'pl' ? 'Dobre jedzenie na co dzień' : 'Good food every day', inLanguage: languageTag(locale), isPartOf: { '@id': `${PUBLIC_SITE_URL}/#website` }, ...(image ? { primaryImageOfPage: { '@type': 'ImageObject', ...image, url: absoluteUrl(image.url) } } : {}) },
    ],
  };
}

export function recipeStructuredData(recipe: PublicRecipe, locale: Locale) {
  const url = absoluteUrl(getRecipeHref(recipe, locale));
  const recipeId = `${PUBLIC_SITE_URL}/#recipe-${encodeURIComponent(recipe.id)}-${locale}`;
  const images = getRecipeImageVariants(recipe);
  const category = categories.find(item => item.id === recipe.primaryCategory)?.label[locale];
  const author = recipe.publication?.author || SITE_NAME;
  const duration = (minutes: number) => `PT${minutes}M`;
  // The timing plan overlaps parallel work, so prep is the remainder of total after cooking; the pair always sums to totalTime.
  const { cooking, total } = recipe.times;
  const splitTimes = cooking > 0 && cooking < total ? { prepTime: duration(total - cooking), cookTime: duration(cooking) } : {};
  const questions = (recipe.seo?.questions ?? []).filter(item => item.question[locale]?.trim() && item.answer[locale]?.trim());
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organizationStructuredData(),
      {
        '@type': 'WebPage', '@id': `${url}#webpage`, url, name: recipe.title[locale], inLanguage: languageTag(locale),
        mainEntity: { '@id': recipeId },
        primaryImageOfPage: { '@type': 'ImageObject', ...images.landscape, url: absoluteUrl(images.landscape.url), caption: recipe.imageAlt[locale] },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: absoluteUrl(`/${locale}`) },
          { '@type': 'ListItem', position: 2, name: recipe.title[locale], item: url },
        ],
      },
      {
        '@type': 'Recipe', '@id': recipeId, url, name: recipe.title[locale], description: formatRecipeDurationText(recipe.description[locale], locale), inLanguage: languageTag(locale),
        mainEntityOfPage: { '@id': `${url}#webpage` },
        author: author === SITE_NAME ? { '@id': `${PUBLIC_SITE_URL}/#organization` } : { '@type': 'Person', name: author },
        publisher: { '@id': `${PUBLIC_SITE_URL}/#organization` },
        ...(recipe.publication ? { datePublished: recipe.publication.datePublished, dateModified: recipe.publication.dateModified } : {}),
        ...(category ? { recipeCategory: category } : {}),
        recipeCuisine: recipe.cuisine[locale],
        ...(recipe.seo?.keywords?.[locale]?.some(word => word.trim()) ? { keywords: recipe.seo.keywords[locale].map(word => word.trim()).filter(Boolean).join(', ') } : {}),
        recipeYield: formatServingCount(recipe.baseServings, locale),
        ...splitTimes,
        totalTime: duration(total),
        image: [images.classic, images.landscape, images.square].map(image => absoluteUrl(image.url)),
        recipeIngredient: recipe.ingredients.map(ingredient => [formatIngredientAmount(ingredient, recipe.baseServings, recipe.baseServings, 'metric', locale), ingredient.name[locale], ingredient.note?.[locale] ? formatRecipeDurationText(ingredient.note[locale], locale) : undefined].filter(Boolean).join(' — ')),
        recipeInstructions: recipe.steps.map(step => {
          const image = recipe.photos?.steps[step.id];
          return {
            '@type': 'HowToStep', name: step.title[locale], text: renderStepText(step, recipe, recipe.baseServings, 'metric', locale), url: `${url}#step-${encodeURIComponent(step.id)}`,
            ...(image && image.columns === 1 && image.rows === 1 ? { image: absoluteUrl(image.src) } : {}),
          };
        }),
      },
      // Mirrors the visible "Cooking questions" section; no rich result is promised, but answers stay machine-readable.
      ...(questions.length ? [{
        '@type': 'FAQPage', '@id': `${url}#questions`, inLanguage: languageTag(locale), isPartOf: { '@id': `${url}#webpage` },
        mainEntity: questions.map(item => ({ '@type': 'Question', name: item.question[locale], acceptedAnswer: { '@type': 'Answer', text: item.answer[locale] } })),
      }] : []),
    ],
  };
}

export function recipeSitemapEntries(recipes: readonly PublicRecipe[]): MetadataRoute.Sitemap {
  return recipes.flatMap(recipe => recipeLocales(recipe).map(locale => ({
    url: absoluteUrl(getRecipeHref(recipe, locale)),
    ...(recipe.publication?.dateModified ? { lastModified: recipe.publication.dateModified } : {}),
    alternates: { languages: withDefaultLanguage(Object.fromEntries(Object.entries(recipeLanguages(recipe)).map(([language, href]) => [language, absoluteUrl(href)]))) },
    images: [getRecipeImageVariants(recipe).landscape.url].map(absoluteUrl),
  })));
}

export function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}

export type LlmsLink = { path: string; title: string; description: string };

/** llms.txt (llmstxt.org): a plain index of published content only; drafts and private media never reach it. */
export function buildLlmsText(recipes: readonly PublicRecipe[], sections: Record<Locale, { collections: LlmsLink[]; guides: LlmsLink[] }>, summary: Record<Locale, string>): string {
  const line = (link: LlmsLink) => `- [${link.title.replace(/[[\]]/g, '')}](${absoluteUrl(link.path)}): ${link.description.replace(/\s+/g, ' ').trim()}`;
  const recipeLine = (recipe: PublicRecipe, locale: Locale) => {
    const category = categories.find(item => item.id === recipe.primaryCategory)?.label[locale];
    const facts = [category, `${recipe.times.total} min`, formatServingCount(recipe.baseServings, locale)].filter(Boolean).join(', ');
    return line({ path: getRecipeHref(recipe, locale), title: recipe.title[locale], description: `${formatRecipeDurationText(recipe.description[locale], locale)} (${facts})` });
  };
  const edition = (locale: Locale) => {
    const pl = locale === 'pl';
    const own = recipes.filter(recipe => recipeLocales(recipe).includes(locale));
    return [
      `## ${pl ? 'Przepisy' : 'Recipes (English)'}`, '', ...own.map(recipe => recipeLine(recipe, locale)), '',
      ...(sections[locale].collections.length ? [`## ${pl ? 'Kolekcje' : 'Collections'}`, '', ...sections[locale].collections.map(line), ''] : []),
      `## ${pl ? 'Poradniki' : 'Guides'}`, '', ...sections[locale].guides.map(line), '',
    ];
  };
  return [
    `# ${SITE_NAME}`, '',
    `> ${summary.pl.replace(/\s+/g, ' ').trim()} / ${summary.en.replace(/\s+/g, ' ').trim()}`, '',
    `Każdy przepis ma dane strukturalne schema.org/Recipe. Edycja polska: ${absoluteUrl('/pl')}; English edition: ${absoluteUrl('/en')}; RSS: ${absoluteUrl('/pl/feed.xml')}, ${absoluteUrl('/en/feed.xml')}.`, '',
    ...edition('pl'), ...edition('en'),
  ].join('\n');
}

export type FeedArticle = { id: string; path: string; title: string; description: string; datePublished?: string; dateModified?: string };

export function buildRecipeFeed(recipes: readonly PublicRecipe[], locale: Locale, articles: readonly FeedArticle[] = []): string {
  const entries: FeedArticle[] = [...recipes.filter(recipe => recipeLocales(recipe).includes(locale)).map(recipe => ({
    id: `${PUBLIC_SITE_URL}/#recipe-${encodeURIComponent(recipe.id)}-${locale}`,
    path: getRecipeHref(recipe, locale), title: recipe.title[locale], description: formatRecipeDurationText(recipe.description[locale], locale),
    datePublished: recipe.publication?.datePublished, dateModified: recipe.publication?.dateModified,
  })), ...articles].sort((a, b) => (b.datePublished ? Date.parse(b.datePublished) : 0) - (a.datePublished ? Date.parse(a.datePublished) : 0)).slice(0, 50);
  const items = entries.map(entry => {
    const url = absoluteUrl(entry.path);
    const date = entry.datePublished;
    return `<item><title>${escapeXml(entry.title)}</title><link>${escapeXml(url)}</link><guid isPermaLink="false">${escapeXml(entry.id)}</guid><description>${escapeXml(entry.description)}</description>${date ? `<pubDate>${new Date(date).toUTCString()}</pubDate>` : ''}</item>`;
  }).join('');
  const dates = entries.map(entry => entry.dateModified).filter((date): date is string => Boolean(date)).sort((a, b) => Date.parse(a) - Date.parse(b));
  const modified = dates.at(-1);
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${SITE_NAME}</title><link>${absoluteUrl(`/${locale}`)}</link><description>${locale === 'pl' ? 'Nowe przepisy na dobre jedzenie na co dzień.' : 'New recipes for good food every day.'}</description><language>${languageTag(locale)}</language><atom:link href="${absoluteUrl(`/${locale}/feed.xml`)}" rel="self" type="application/rss+xml"/>${modified ? `<lastBuildDate>${new Date(modified).toUTCString()}</lastBuildDate>` : ''}${items}</channel></rss>`;
}
