// The jesie.pl food blog (2014–2017) left these sections in search indexes and backlinks.
// None of its posts has an equivalent in the current catalogue, so they lead to the Polish catalogue
// instead of a 404; contact and about pages, and the feed, have direct counterparts.
// Source: Wayback Machine CDX inventory of jesie.pl, October 2026.
const catalogueSections = [
  'przepisy', 'category', 'tag', 'bez-kategorii-pl', 'uncategorized', 'easyrecipe-print', 'inspiracje',
  'pogaduchy', 'blog', 'demo', 'ale-kino', 'w-kuchi-i-na-stole', 'od-kuchni', 'na-miescie', 'na-stol', 'na-stole-2',
  'ankieta', 'restauracja', 'czytelnia', 'cytaty', 'palarnie-kawy-w-polsce', 'calendar',
] as const;

export type LegacyRedirect = { source: string; destination: string; permanent: true };

export const legacyRedirects: LegacyRedirect[] = [
  ...catalogueSections.map(section => ({ source: `/${section}/:path*`, destination: '/pl', permanent: true as const })),
  ...['kontakt', 'oto-my'].map(section => ({ source: `/${section}/:path*`, destination: '/pl/o-serwisie', permanent: true as const })),
  { source: '/feed/:path*', destination: '/pl/feed.xml', permanent: true },
];
