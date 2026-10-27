/** Reader-facing recipe copy is self-contained; research stays in private sources. */
export type RecipeExternalReference = { path: string; text: string; reason: string };

const ownHosts = new Set(['jesie.pl', 'www.jesie.pl', 'zgotujsobie.vercel.app']);
const serviceNames = /\b(?:Whole Foods(?: Market)?|AGFG|BBC\s*(?:Good\s*Food|Food)|Serious\s*Eats|Allrecipes|Delish|Kenna['’]?s\s*Cooks|The\s*Spruce\s*Eats|Food\s*Network|Food\s*Standards(?:\s*Agency|\s*Scotland)?|Eat\s*Yourself\s*Skinny|Giallo\s*Zafferano|La\s*Cucina\s*Italiana|Oregon\s*State(?:\s*University)?|FDA|USDA|NYT\s*Cooking|New\s*York\s*Times\s*Cooking|Cooking\s*Light|Cookidoo|Cookpad|Epicurious|Simply\s*Recipes|RecipeTin\s*Eats|TikTok|YouTube|Instagram|Pinterest|Facebook|Kwestia\s*Smaku|Ania\s*Gotuje|AniaGotuje|Moje\s*Wypieki|Smaker|Przepisy\.pl)\b/iu;
const attribution = /(?:\b(?:według|wg\.?|zgodnie z|na podstawie|jak (?:podaje|zaleca)|zobacz|sprawdź|poleca|zaleca)\s+(?:(?:przepis(?:em|u)?|wskazówk(?:ami|i)|zaleceni(?:ami|a))\s+)?(?:serwis\p{L}*|portal\p{L}*|stron\p{L}*|blog\p{L}*|witryn\p{L}*)\b|\b(?:according to (?:the )?(?:website|site|blog|portal)|adapted from (?:the )?(?:website|site|blog)|recipe from (?:the )?(?:website|site|blog)|visit (?:the )?(?:website|blog)|see (?:the )?(?:website|blog))\b|(?:źródł[oa]|sources?)\s*:)/iu;
const namedAttribution = /(?:\b(?:według|Według|wg\.|W przepisie|w przepisie|according to|According to|recipe from|Recipe from|adapted from|inspired by|as recommended by)\s+(?:[A-ZĄĆĘŁŃÓŚŹŻ][\p{L}\d]+\s+){0,5}(?:Site|Blog|Portal|Kitchen|Cooking|Recipes|Cookery|Serwis|Kuchnia|Bon App[ée]tit)\b)/u;
const siteAttribution = /(?:\b(?:przepis|inspiracj\p{L}*|porad\p{L}*|zaleceni\p{L}*)\s+(?:ze?\s+(?:strony|portalu|serwisu|bloga)|na\s+(?:stronie|portalu|blogu))\b|\b(?:inspired by|adapted from|as recommended by)\s+(?:the\s+)?(?:website|site|blog|portal)\b)/iu;
const citation = /(?:[^]*|【\d+(?:†[^】]*)?】|\[\d+(?:\s*[,–-]\s*\d+)*\]|\[[^\]]+\]:\s*\S+|\bcite\s*[:{])/iu;
const addresses = /(?:\b(?:https?|ftp):\/\/[^\s<>"\]]+|\/\/[^\s<>"\]]+|(?<![\p{L}\d_@/-])(?:www\.)?(?:[\p{L}\d](?:[\p{L}\d-]*[\p{L}\d])?\.)+(?:[a-z]{2,63})(?![\p{L}\d_-]))/giu;
const privateKeys = new Set(['provenance', 'heroPresentation', 'originalText', 'author', 'sources', 'kitchenTest', 'aiPhotography']);
const technicalKeys = new Set(['id', 'ingredientId', 'slug', 'image', 'src', 'version', 'publication', 'trendConfirmedAt', 'relatedRecipeIds', 'collectionIds']);

function hasExternalAddress(text: string) {
  for (const match of text.matchAll(addresses)) {
    if (match[0].toLowerCase() === 'm.in') continue;
    try {
      const url = new URL(match[0].startsWith('//') ? `https:${match[0]}` : /^[a-z]+:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
      if (!ownHosts.has(url.hostname.toLowerCase())) return true;
    } catch { return true; }
  }
  return false;
}

/** Accept a recipe DTO or EditorialContent; never inspect private bibliography. */
export function findRecipeExternalReferences(input: unknown): RecipeExternalReference[] {
  if (Array.isArray(input)) return input.flatMap((item, index) => findRecipeExternalReferences(item).map(issue => ({ ...issue, path: `${index}.${issue.path}` })));
  const issues: RecipeExternalReference[] = [];
  function visit(value: unknown, path: string) {
    if (typeof value === 'string') {
      const text = value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
      if (hasExternalAddress(text) || serviceNames.test(text) || attribution.test(text) || namedAttribution.test(text) || siteAttribution.test(text) || citation.test(text)
        || /<(?:a|iframe)\b[^>]*(?:href|src)\s*=\s*["']?(?:https?:|\/\/)/iu.test(text)) {
        issues.push({ path, text: value, reason: 'Usuń link, cytowanie lub odwołanie do zewnętrznego serwisu z treści przepisu. Źródła zapisz wyłącznie w prywatnej bibliografii.' });
      }
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}.${index}`));
    else if (value && typeof value === 'object') {
      // Keys in photo maps are arbitrary ingredient/step IDs, never field names.
      const photoMap = /^(?:recipe\.)?photos\.(?:ingredients|steps)$/.test(path);
      for (const [key, item] of Object.entries(value)) {
        if (!photoMap && (technicalKeys.has(key) || (path === '' || path === 'recipe') && privateKeys.has(key))) continue;
        visit(item, path ? `${path}.${key}` : key);
      }
    }
  }
  visit(input, '');
  return issues;
}

export function assertRecipeHasNoExternalReferences(input: unknown): void {
  const issues = findRecipeExternalReferences(input);
  if (issues.length) throw new Error(`RECIPE_EXTERNAL_REFERENCE: ${issues.map(issue => issue.path).join(', ')}`);
}
