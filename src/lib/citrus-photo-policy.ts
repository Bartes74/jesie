import type { Ingredient } from './recipes';
import type { MediaTile } from './recipe-media';

export type LemonPhotoForm = 'juice' | 'zest';
type PhotoIngredient = Pick<Ingredient, 'id' | 'name' | 'note'>;
type PhotoIdentity = Pick<MediaTile, 'src' | 'columns' | 'rows' | 'index'>;
export const lemonPhotoSources: Record<LemonPhotoForm, string> = {
  juice: '/images/lemon-juice.webp', zest: '/images/lemon-zest.webp',
};
const normalize = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/ł/gu, 'l').toLowerCase().replace(/[_-]+/gu, ' ');
const lemon = /\blemons?\b|\bcytryn\p{L}*/iu;
const otherCitrus = /\blimes?\b|\blimon\p{L}*|\boranges?\b|\bpomarancz\p{L}*/iu;
const juice = /\bjuice\b|\bsok(?:u|iem)?\b|\bsqueez\p{L}*|\bwycisn\p{L}*/iu;
const zest = /\bzest\b|\bpeel\b|\brind\b|\bskork\p{L}*|\botart\p{L}*/iu;
function forms(text: string): LemonPhotoForm[] {
  return [...(juice.test(text) ? ['juice' as const] : []), ...(zest.test(text) ? ['zest' as const] : [])];
}

/** Names describe the product; an old target ID cannot override an explicit new name. */
export function lemonIngredientPhotoForm(ingredient: PhotoIngredient): LemonPhotoForm | 'conflict' | null {
  const names = normalize(`${ingredient.name.pl} ${ingredient.name.en}`);
  if (!lemon.test(names) && otherCitrus.test(names)) return null;
  const id = normalize(ingredient.id);
  if (!lemon.test(names) && !lemon.test(id)) return null;
  const namedForms = forms(names);
  if (lemon.test(names) && !namedForms.length) return null;
  if (names.trim() && !lemon.test(names) && !namedForms.length) return null;
  const selected = new Set(namedForms.length ? namedForms : forms(id));
  // A whole lemon used later for juice/zest is still a whole ingredient photo.
  if (!selected.size) return null;
  for (const note of [ingredient.note?.pl, ingredient.note?.en]) {
    const first = normalize(note?.split(/[.;:]/u, 1)[0] ?? '').trim();
    if (/\b(?:if|when|later|optional|jesli|gdy|pozniej|potem)\b/iu.test(first)) continue;
    if (/^(?:freshly |finely |drobno |swiezo )?(?:juice|sok|squeez|wycisn|zest|peel|rind|skork|otart|grated zest|starta skorka)/iu.test(first)) {
      for (const form of forms(first)) selected.add(form);
    }
  }
  return selected.size > 1 ? 'conflict' : [...selected][0] ?? null;
}

/** The atlas is a picture of lemon and zest, never a photograph of juice. */
export function knownLemonPhotoForm(photo: PhotoIdentity, knownSources: ReadonlyMap<string, LemonPhotoForm> = new Map()): LemonPhotoForm | null {
  const known = knownSources.get(photo.src);
  if (known) return known;
  if (photo.src === lemonPhotoSources.juice) return 'juice';
  if (photo.src === lemonPhotoSources.zest || photo.src === '/images/ingredients-1.webp' && photo.columns === 4 && photo.rows === 3 && photo.index === 4) return 'zest';
  return null;
}

export function ingredientPhotoIdentity(photo: PhotoIdentity): string {
  return JSON.stringify([photo.src, photo.columns, photo.rows, photo.index]);
}

export function lemonIngredientPhotoIssue(ingredient: PhotoIngredient, photo: PhotoIdentity, knownSources?: ReadonlyMap<string, LemonPhotoForm>): string | null {
  const expected = lemonIngredientPhotoForm(ingredient);
  if (expected === 'conflict') return 'Rozdziel sok i skórkę cytryny na osobne składniki i osobne zdjęcia.';
  const actual = knownLemonPhotoForm(photo, knownSources);
  if (expected && actual && actual !== expected) return expected === 'juice'
    ? 'Sok z cytryny wymaga zdjęcia soku. Nie używaj zdjęcia skórki ani dawnego kadru cytryny ze skórką.'
    : 'Skórka z cytryny wymaga zdjęcia skórki. Nie używaj zdjęcia soku.';
  return null;
}

/** Validate new edits/publications without changing immutable historical snapshots. */
export function lemonPhotoPolicyIssues(ingredients: readonly PhotoIngredient[], photos: Readonly<Record<string, MediaTile>>, knownSources?: ReadonlyMap<string, LemonPhotoForm>) {
  const issues: { ingredientId: string; message: string }[] = [];
  const seen = new Map<string, { ingredientId: string; form: LemonPhotoForm }[]>();
  for (const ingredient of ingredients) {
    const photo = photos[ingredient.id];
    if (!photo) continue;
    const issue = lemonIngredientPhotoIssue(ingredient, photo, knownSources);
    if (issue) issues.push({ ingredientId: ingredient.id, message: issue });
    const form = lemonIngredientPhotoForm(ingredient);
    if (form !== 'juice' && form !== 'zest') continue;
    const identity = ingredientPhotoIdentity(photo);
    const prior = seen.get(identity) ?? [];
    for (const other of prior) if (other.form !== form) {
      const message = 'Sok i skórka cytryny nie mogą korzystać z tego samego zdjęcia i kadru.';
      issues.push({ ingredientId: ingredient.id, message }, { ingredientId: other.ingredientId, message });
    }
    seen.set(identity, [...prior, { ingredientId: ingredient.id, form }]);
  }
  return issues;
}
