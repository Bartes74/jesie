import type { Ingredient, Localised, Locale } from './recipes';

export type IngredientProduct = { id: string; name: Localised; aliases: string[]; legacyIds?: string[] };
type IngredientRecipe = { ingredients: Ingredient[] };

export function normalizeIngredientName(value: string): string {
  return value.toLocaleLowerCase('pl').replaceAll('ł', 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9%]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function product(id: string, pl: string, en: string, ...aliases: string[]): IngredientProduct {
  return { id, name: { pl, en }, aliases: [...new Set([pl, en, ...aliases].map(normalizeIngredientName))] };
}

// Aliases are explicit culinary equivalents. In particular, fats, flour types,
// dairy products and plant milks retain separate identities.
const PRODUCTS: IngredientProduct[] = [
  product('milk', 'Mleko', 'Milk', 'mleko krowie', 'cow milk', 'whole milk', 'mleko pelne'),
  product('coconut-milk', 'Mleczko kokosowe', 'Coconut milk', 'mleko kokosowe'),
  product('oat-milk', 'Napój owsiany', 'Oat milk', 'mleko owsiane'),
  product('almond-milk', 'Napój migdałowy', 'Almond milk', 'mleko migdalowe'),
  product('butter', 'Masło', 'Butter', 'zimne maslo pokrojone', 'cold butter cubed', 'maslo do formy', 'butter for greasing the tin', 'unsalted butter', 'maslo niesolone'),
  product('clarified-butter', 'Masło klarowane', 'Clarified butter', 'ghee'),
  product('olive-oil', 'Oliwa', 'Olive oil', 'oliwa z oliwek', 'oliwa do pieczenia', 'olive oil for roasting', 'extra virgin olive oil'),
  product('rapeseed-oil', 'Olej rzepakowy', 'Rapeseed oil', 'canola oil'),
  product('sunflower-oil', 'Olej słonecznikowy', 'Sunflower oil'),
  product('coconut-oil', 'Olej kokosowy', 'Coconut oil'),
  product('frying-oil', 'Olej do smażenia', 'Frying oil', 'olej do posmarowania patelni', 'oil for greasing the pan', 'olej do smazenia'),
  product('plain-flour', 'Mąka pszenna', 'Plain flour', 'maka pszenna tortowa', 'all purpose flour', 'maka do podsypywania', 'flour for dusting'),
  product('wholemeal-flour', 'Mąka pszenna pełnoziarnista', 'Wholemeal wheat flour', 'whole wheat flour'),
  product('rye-flour', 'Mąka żytnia', 'Rye flour'),
  product('rice-flour', 'Mąka ryżowa', 'Rice flour'),
  product('cornflour', 'Skrobia kukurydziana', 'Cornflour', 'corn starch', 'cornstarch'),
  product('potato-starch', 'Skrobia ziemniaczana', 'Potato starch', 'maka ziemniaczana'),
  product('self-raising-flour', 'Mąka samorosnąca', 'Self-raising flour', 'self raising flour'),
  product('eggs', 'Jajka', 'Eggs', 'jajko', 'egg', 'jajka sredniej wielkosci', 'jajko sredniej wielkosci', 'medium eggs', 'medium egg'),
  product('cream-30', 'Śmietanka 30%', 'Whipping cream', 'smietanka 30%', '30% cream'),
  product('cream-36', 'Śmietanka 36%', 'Double cream', 'smietanka 36%', '36% cream'),
  product('sour-cream', 'Śmietana kwaśna', 'Sour cream', 'smietana 18%', 'smietana 12%'),
  product('yoghurt', 'Jogurt naturalny', 'Natural yoghurt', 'plain yoghurt', 'plain yogurt', 'natural yogurt'),
  product('greek-yoghurt', 'Jogurt grecki', 'Greek yoghurt', 'greek yogurt'),
  product('ricotta', 'Ricotta', 'Ricotta', 'ricotta odsaczona', 'ricotta drained'),
  product('feta', 'Feta', 'Feta'),
  product('hard-cheese', 'Dojrzewający ser twardy', 'Mature hard cheese', 'dojrzewajacy ser twardy drobno starty', 'mature hard cheese finely grated'),
  product('parmesan', 'Parmezan', 'Parmesan', 'parmigiano reggiano'),
  product('mozzarella', 'Mozzarella', 'Mozzarella'),
  product('sugar', 'Cukier', 'Caster sugar', 'sugar', 'cukier do jablek', 'sugar for the apples', 'bialy cukier', 'white sugar'),
  product('brown-sugar', 'Cukier brązowy', 'Brown sugar'),
  product('icing-sugar', 'Cukier puder', 'Icing sugar', 'powdered sugar'),
  product('honey', 'Miód', 'Honey'),
  product('baking-powder', 'Proszek do pieczenia', 'Baking powder'),
  product('baking-soda', 'Soda oczyszczona', 'Bicarbonate of soda', 'baking soda'),
  product('yeast', 'Drożdże świeże', 'Fresh yeast'),
  product('dry-yeast', 'Drożdże suszone', 'Dried yeast', 'instant yeast'),
  product('salt', 'Sól', 'Salt', 'sol do ciasta', 'salt for the dough', 'sol do wody', 'salt for the cooking water'),
  product('black-pepper', 'Pieprz czarny', 'Black pepper', 'pieprz', 'pepper', 'swiezo mielony pieprz', 'freshly ground black pepper'),
  product('water', 'Woda', 'Water', 'ciepla woda', 'warm water'),
  product('tagliatelle', 'Tagliatelle', 'Tagliatelle', 'tagliatelle suche', 'dried tagliatelle'),
  product('spaghetti', 'Spaghetti', 'Spaghetti', 'spaghetti suche', 'dried spaghetti'),
  product('rice', 'Ryż', 'Rice', 'white rice', 'ryz bialy'),
  product('oats', 'Płatki owsiane', 'Rolled oats', 'oat flakes'),
  product('pumpkin', 'Dynia', 'Pumpkin', 'miazsz dyni bez pestek i skorki', 'pumpkin flesh peeled and deseeded'),
  product('pumpkin-seeds', 'Pestki dyni', 'Pumpkin seeds'),
  product('onion', 'Cebula', 'Onion', 'cebula obrana', 'onion peeled'),
  product('red-onion', 'Czerwona cebula', 'Red onion'),
  product('garlic', 'Czosnek', 'Garlic', 'czosnek obrany', 'garlic peeled'),
  product('ginger', 'Imbir', 'Ginger', 'swiezy imbir obrany', 'fresh ginger peeled'),
  product('vegetable-stock', 'Bulion warzywny', 'Vegetable stock', 'vegetable broth'),
  product('chicken-stock', 'Bulion drobiowy', 'Chicken stock', 'chicken broth'),
  product('spinach', 'Szpinak świeży', 'Fresh spinach', 'swiezy szpinak'),
  product('frozen-spinach', 'Szpinak mrożony', 'Frozen spinach', 'mrozony szpinak'),
  product('basil', 'Bazylia świeża', 'Fresh basil', 'swieza bazylia'),
  product('sage', 'Szałwia świeża', 'Fresh sage', 'swieza szalwia'),
  product('rocket', 'Rukola', 'Rocket', 'arugula'),
  product('nutmeg', 'Gałka muszkatołowa', 'Nutmeg', 'ground nutmeg'),
  product('cinnamon', 'Cynamon', 'Cinnamon', 'ground cinnamon'),
  product('lemon', 'Cytryna', 'Lemon', 'cytryny', 'lemons'),
  product('lemon-zest', 'Skórka cytrynowa', 'Lemon zest', 'skorka z umytej niewoskowanej cytryny', 'finely grated zest of an unwaxed lemon'),
  product('lemon-juice', 'Sok z cytryny', 'Lemon juice'),
  product('lime', 'Limonka', 'Lime'),
  product('apples', 'Jabłka', 'Apples', 'jablko', 'apple', 'jablka obrane i bez gniazd nasiennych', 'apples peeled and cored'),
  product('berries', 'Owoce jagodowe', 'Mixed berries'),
  product('strawberries', 'Truskawki', 'Strawberries'),
  product('blueberries', 'Borówki', 'Blueberries'),
  product('raspberries', 'Maliny', 'Raspberries'),
  product('beetroot', 'Buraki', 'Beetroot', 'buraki obrane', 'beetroot peeled', 'beets'),
  product('walnuts', 'Orzechy włoskie', 'Walnuts'),
  product('tomatoes', 'Pomidory', 'Tomatoes', 'pomidor', 'tomato'),
  product('potatoes', 'Ziemniaki', 'Potatoes', 'ziemniak', 'potato'),
  product('carrots', 'Marchew', 'Carrots', 'marchewka', 'carrot'),
  product('chickpeas', 'Ciecierzyca', 'Chickpeas'),
  product('lentils', 'Soczewica', 'Lentils'),
  product('chicken', 'Pierś z kurczaka', 'Chicken breast'),
  product('salmon', 'Łosoś', 'Salmon'),
  product('tofu', 'Tofu', 'Tofu'),
  product('balsamic-vinegar', 'Ocet balsamiczny', 'Balsamic vinegar'),
  product('soy-sauce', 'Sos sojowy', 'Soy sauce'),
];

const ALIASES = new Map(PRODUCTS.flatMap(item => item.aliases.map(alias => [alias, item.id] as const)));
const COMPOUNDS = new Map([
  ['sol i pieprz do nadzienia', ['salt', 'black-pepper']],
  ['salt and pepper for the filling', ['salt', 'black-pepper']],
  ['sol i pieprz', ['salt', 'black-pepper']],
  ['salt and pepper', ['salt', 'black-pepper']],
]);

function ingredientAliases(name: string): string[] {
  const aliases = [normalizeIngredientName(name)];
  const [base, preparation] = name.split(/[,;]/, 2);
  // Remove preparation instructions, never arbitrary qualifiers such as dried,
  // coconut, wholemeal, smoked or a fat percentage.
  if (preparation && /^\s*(?:drobno\s+)?(?:posiekan|pokrojon|obran|ods[aą]czon|start|finely\s+|chopped|diced|cubed|peeled|drained|grated)/i.test(preparation)) aliases.push(normalizeIngredientName(base));
  return aliases;
}

function literalPart(name: string): string {
  if (name.length <= 140) return name;
  // Keep identifiers small enough for a 30-product GET query. Two independent
  // fingerprints retain the full literal name's identity after abbreviation.
  let first = 2166136261;
  let second = 2246822519;
  for (let i = 0; i < name.length; i++) {
    first = Math.imul(first ^ name.charCodeAt(i), 16777619);
    second = Math.imul(second ^ name.charCodeAt(i), 3266489917);
  }
  return `${name.slice(0,120)}-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function ingredientProductIds(ingredient: Pick<Ingredient, 'name'>): string[] {
  const names = [ingredient.name.pl, ingredient.name.en].map(normalizeIngredientName);
  for (const name of names) {
    const compound = COMPOUNDS.get(name);
    if (compound) return [...compound];
  }
  const identities = [...new Set([ingredient.name.pl, ingredient.name.en].flatMap(ingredientAliases).map(name => ALIASES.get(name)).filter((id): id is string => Boolean(id)))];
  // Conflicting translations are never silently merged into a known product.
  if (identities.length === 1) return identities;
  // Unknown products keep the Polish identity when an English translation changes.
  // A conflict between two *known* identities remains isolated instead of matching either.
  return [identities.length > 1 ? `literal:${names.map(literalPart).join('|')}` : `literal:${literalPart(ingredientAliases(ingredient.name.pl || ingredient.name.en).at(-1) ?? names[0])}`];
}

export function ingredientProductId(ingredient: Pick<Ingredient, 'name'>): string {
  return ingredientProductIds(ingredient)[0];
}

export function buildIngredientCatalog(recipes: IngredientRecipe[]): IngredientProduct[] {
  const products = new Map(PRODUCTS.map(item => [item.id, item]));
  for (const recipe of recipes) for (const ingredient of recipe.ingredients) {
    for (const id of ingredientProductIds(ingredient)) if (!products.has(id)) {
      products.set(id, { id, name: ingredient.name, aliases: [normalizeIngredientName(ingredient.name.pl), normalizeIngredientName(ingredient.name.en)], legacyIds: [`literal:${[ingredient.name.pl, ingredient.name.en].map(normalizeIngredientName).map(literalPart).join('|')}`] });
    }
  }
  return [...products.values()];
}

export function searchIngredientCatalog(products: IngredientProduct[], query: string, locale: Locale, limit = 30): IngredientProduct[] {
  const words = normalizeIngredientName(query).split(' ').filter(Boolean);
  return products.filter(item => words.every(word => item.aliases.some(alias => alias.includes(word))))
    .sort((a, b) => a.name[locale].localeCompare(b.name[locale], locale)).slice(0, Math.min(30, Math.max(0, limit)));
}

/** Read old bilingual literal IDs without guessing equivalence between distinct products. */
export function canonicalizeProductIds(ids: string[], products: IngredientProduct[] = []): string[] {
  const known = new Map([...PRODUCTS, ...products].map(item => [item.id, item]));
  return [...new Set(ids.map(id => {
    if (known.has(id) || !id.startsWith('literal:')) return id;
    const literal = id.slice(8);
    const names = literal.split('|');
    const identities = [...new Set(names.map(name => ALIASES.get(name)).filter((value): value is string => Boolean(value)))];
    if (identities.length > 1) return id;
    if (identities.length === 1) return identities[0];
    const exact = products.filter(item => item.legacyIds?.includes(id));
    if (exact.length === 1) return exact[0].id;
    // The original primary-language literal is the only safe migration anchor.
    return `literal:${names[0]}`;
  }))];
}

export function expandOwnedProducts(ids: string[], products: IngredientProduct[] = []): Set<string> {
  const owned = new Set(canonicalizeProductIds(ids, products));
  // A whole lemon supplies both juice and zest. Bottled juice supplies no zest.
  if (owned.has('lemon')) { owned.add('lemon-juice'); owned.add('lemon-zest'); }
  return owned;
}
