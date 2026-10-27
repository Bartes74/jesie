import { recipes, type Ingredient } from './recipes';
import type { MediaTile } from './recipe-media';
import { ingredientPhotoIdentitiesCompatible, ingredientPhotoSemanticIdentity, type IngredientPhotoSemanticIdentity, type IngredientPhotoSubject } from './ingredient-photo-identity';

type PhotoLocation = Pick<MediaTile, 'src' | 'columns' | 'rows' | 'index'>;
export type StaticIngredientPhotoEntry = { photo: PhotoLocation; source: IngredientPhotoSubject; identity: IngredientPhotoSemanticIdentity; visible: string };
const atlas = (sheet: number, index: number, product: string, forms: string[], pl: string, en: string, visible: string): StaticIngredientPhotoEntry => ({
  photo: { src: `/images/ingredients-${sheet}.webp`, columns: 4, rows: 3, index }, source: { name: { pl, en } }, identity: { product, forms }, visible,
});
const standalone = (src: string, product: string, forms: string[], pl: string, en: string, visible: string): StaticIngredientPhotoEntry => ({
  photo: { src, columns: 1, rows: 1, index: 0 }, source: { name: { pl, en } }, identity: { product, forms }, visible,
});

/** Curated visual truth, independent of the recipe IDs that historically selected a crop. */
export const staticIngredientPhotoRegistry: readonly StaticIngredientPhotoEntry[] = [
  atlas(1, 0, 'tagliatelle', ['dried'], 'suche tagliatelle', 'dried tagliatelle', 'One dry ribbon-pasta nest.'),
  atlas(1, 1, 'butter', ['diced'], 'masło w kostkach', 'cubed butter', 'Three solid butter pieces; also suitable for unspecified solid butter.'),
  atlas(1, 2, 'whipping-cream', ['fat-30'], 'śmietanka 30%', 'whipping cream', 'Pourable cream in a jug; not whipped cream.'),
  atlas(1, 3, 'mature-hard-cheese', ['grated'], 'drobno starty dojrzewający ser twardy', 'finely grated mature hard cheese', 'A cheese wedge beside the grated cheese.'),
  atlas(1, 4, 'lemon', ['grated', 'zest'], 'starta skórka z cytryny', 'grated lemon zest', 'Lemon half beside grated zest; no squeezed juice.'),
  atlas(1, 5, 'basil', [], 'świeża bazylia', 'fresh basil', 'Fresh basil leaves.'),
  atlas(1, 6, 'salt', [], 'sól', 'salt', 'White salt flakes only; no pepper.'),
  atlas(1, 7, 'black-pepper', ['ground'], 'mielony czarny pieprz', 'ground black pepper', 'Peppercorns beside cracked and ground pepper.'),
  atlas(1, 8, 'water', [], 'woda', 'water', 'Clear drinking water, not cloudy pasta cooking water.'),
  atlas(1, 9, 'pumpkin', ['deseeded', 'diced', 'peeled'], 'obrany miąższ dyni bez pestek', 'peeled deseeded pumpkin flesh', 'Orange peeled seedless pumpkin cubes.'),
  atlas(1, 10, 'onion', ['peeled'], 'obrana cebula', 'peeled onion', 'Peeled onion halves with root ends retained.'),
  atlas(1, 11, 'garlic', ['peeled'], 'obrany czosnek', 'peeled garlic', 'Two peeled garlic cloves.'),
  atlas(2, 0, 'ginger', ['unpeeled'], 'nieobrany imbir', 'unpeeled ginger', 'Skin-on ginger root and one cut cross-section.'),
  atlas(2, 1, 'olive-oil', [], 'oliwa', 'olive oil', 'Golden olive oil in a glass jug; not a source for rapeseed or generic neutral-oil aliases.'),
  atlas(2, 2, 'vegetable-stock', [], 'bulion warzywny', 'vegetable stock', 'Golden liquid stock in a bowl.'),
  atlas(2, 3, 'coconut-milk', [], 'mleczko kokosowe', 'coconut milk', 'Coconut milk in a jug beside a coconut piece.'),
  atlas(2, 4, 'pumpkin-seeds', [], 'pestki dyni', 'pumpkin seeds', 'Shelled green pumpkin seeds.'),
  atlas(2, 5, 'plain-wheat-flour', [], 'mąka pszenna', 'plain flour', 'White flour in a bowl.'),
  atlas(2, 6, 'spinach', [], 'świeży szpinak', 'fresh spinach', 'Fresh spinach leaves; not frozen or cooked spinach.'),
  atlas(2, 7, 'ricotta', ['drained'], 'odsączona ricotta', 'drained ricotta', 'Soft ricotta curds without pooled whey; also suitable for unspecified ricotta.'),
  atlas(2, 8, 'nutmeg', ['ground'], 'mielona gałka muszkatołowa', 'ground nutmeg', 'Whole nutmeg beside grated nutmeg.'),
  atlas(2, 9, 'sage', [], 'świeża szałwia', 'fresh sage', 'Fresh sage leaves.'),
  atlas(2, 10, 'egg', [], 'jajka', 'eggs', 'A shell egg beside a cracked raw egg; not beaten or cooked.'),
  atlas(2, 11, 'milk', [], 'mleko', 'milk', 'Liquid milk in a glass jug.'),
  atlas(3, 0, 'caster-sugar', [], 'cukier', 'caster sugar', 'Granulated white sugar.'),
  atlas(3, 1, 'baking-powder', [], 'proszek do pieczenia', 'baking powder', 'Fine white baking powder.'),
  atlas(3, 2, 'mixed-berries', [], 'owoce jagodowe', 'mixed berries', 'Fresh raspberries and blueberries.'),
  atlas(3, 3, 'honey', [], 'miód', 'honey', 'Liquid honey with a dipper.'),
  atlas(3, 4, 'apple', ['sliced', 'uncored', 'unpeeled'], 'nieobrane jabłka z gniazdami nasiennymi', 'unpeeled uncored apples', 'Skin-on apple half with seeds and skin-on apple slices.'),
  atlas(3, 5, 'cinnamon', ['ground'], 'mielony cynamon', 'ground cinnamon', 'Ground cinnamon beside a cinnamon stick.'),
  atlas(3, 6, 'icing-sugar', [], 'cukier puder', 'icing sugar', 'Powdered icing sugar.'),
  atlas(3, 7, 'beetroot', ['peeled'], 'obrane buraki', 'peeled beetroot', 'Peeled raw beetroot chunks.'),
  atlas(3, 8, 'rocket', [], 'rukola', 'rocket', 'Fresh rocket leaves.'),
  atlas(3, 9, 'feta', [], 'feta', 'feta', 'Feta block and crumbles.'),
  atlas(3, 10, 'walnut', ['whole'], 'orzechy włoskie', 'walnuts', 'Whole walnut kernels and halves; not ground walnuts.'),
  atlas(3, 11, 'balsamic-vinegar', [], 'ocet balsamiczny', 'balsamic vinegar', 'Dark liquid balsamic vinegar.'),
  standalone('/images/lemon-juice.webp', 'lemon', ['juice'], 'sok z cytryny', 'lemon juice', 'Verified separate photograph of liquid lemon juice.'),
  standalone('/images/lemon-zest.webp', 'lemon', ['grated', 'zest'], 'starta skórka z cytryny', 'grated lemon zest', 'Verified separate photograph of grated lemon zest.'),
  standalone('/images/ingredients/ginger-peeled.webp', 'ginger', ['grated', 'peeled'], 'obrany i starty imbir', 'peeled grated ginger', 'Verified existing asset: peeled ginger piece and grated ginger.'),
  standalone('/images/ingredients/pasta-water.webp', 'pasta-water', [], 'woda z gotowania makaronu', 'pasta cooking water', 'Verified existing asset: cloudy starchy cooking water.'),
  standalone('/images/ingredients/rapeseed-oil.webp', 'rapeseed-oil', [], 'olej rzepakowy', 'rapeseed oil', 'Verified existing rapeseed-oil source, golden oil in a narrow glass bottle.'),
  standalone('/images/ingredients/neutral-oil.webp', 'neutral-oil', [], 'olej neutralny', 'neutral oil', 'Verified separate neutral-flavoured oil source in a clear bowl.'),
  standalone('/images/ingredients/apples-peeled-cored.webp', 'apple', ['cored', 'peeled'], 'obrane jabłka bez gniazd nasiennych', 'peeled cored apples', 'Reviewed replacement: peeled apple pieces without seeds or cores.'),
  standalone('/images/ingredients/salt-and-pepper.webp', 'salt-and-pepper', ['ground'], 'sól i mielony czarny pieprz', 'salt and ground black pepper', 'Reviewed replacement: both salt and ground black pepper.'),
  standalone('/images/ingredients/butternut-squash-flesh.webp', 'butternut-squash', ['deseeded', 'diced', 'peeled'], 'miąższ dyni piżmowej w kostkach', 'diced butternut squash flesh', 'Reviewed replacement: peeled seedless raw butternut squash cubes.'),
  standalone('/images/ingredients/red-wine.webp', 'red-wine', [], 'czerwone wino', 'red wine', 'Reviewed replacement: liquid red wine.'),
];

export const standaloneIngredientPhotoPaths: readonly string[] = staticIngredientPhotoRegistry.filter(entry => entry.photo.columns === 1).map(entry => entry.photo.src);
export const staticIngredientPhotoPaths: readonly string[] = [...new Set(staticIngredientPhotoRegistry.map(entry => entry.photo.src))];
function entryFor(photo: PhotoLocation) {
  return staticIngredientPhotoRegistry.find(entry => entry.photo.src === photo.src && entry.photo.columns === photo.columns
    && entry.photo.rows === photo.rows && entry.photo.index === photo.index) ?? null;
}
export function knownStaticIngredientPhotoSource(photo: PhotoLocation): IngredientPhotoSubject | null {
  return structuredClone(entryFor(photo)?.source ?? null);
}
export function knownStaticIngredientPhotoIdentity(photo: PhotoLocation): IngredientPhotoSemanticIdentity | null {
  return structuredClone(entryFor(photo)?.identity ?? null);
}

/** Canonical replacements are selected by the current ingredient, never by a stale role ID. */
export function staticIngredientPhotoOverride(recipeId: string, target: string | IngredientPhotoSubject): MediaTile | null {
  const ingredient = typeof target === 'string' ? recipes.find(recipe => recipe.id === recipeId)?.ingredients.find(item => item.id === target) : target;
  if (!ingredient) return null;
  const identity = ingredientPhotoSemanticIdentity(ingredient);
  const replacements = staticIngredientPhotoRegistry.filter(entry => entry.photo.columns === 1);
  const candidate = replacements.find(entry => {
    if (entry.identity.product !== identity.product) return false;
    if (identity.product === 'ginger' && !identity.forms.includes('peeled')) return false;
    if (identity.product === 'apple' && !identity.forms.includes('peeled') && !identity.forms.includes('cored')) return false;
    return ingredientPhotoIdentitiesCompatible(entry.identity, identity);
  });
  return candidate ? { ...candidate.photo, alt: structuredClone(ingredient.name), aspectRatio: 1 } : null;
}

export function isKnownStaticIngredientPhoto(photo: PhotoLocation, ingredient: Pick<Ingredient, 'name' | 'note'> & { id?: string }) {
  const source = knownStaticIngredientPhotoIdentity(photo);
  return source ? ingredientPhotoIdentitiesCompatible(source, ingredientPhotoSemanticIdentity(ingredient)) : false;
}
