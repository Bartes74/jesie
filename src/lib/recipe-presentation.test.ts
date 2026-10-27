import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes, type Recipe } from './recipes';
import { latestPublishedRecipe, toPublicRecipe } from './recipe-presentation';
import { resolveHeroPresentation } from './hero-presentation';

test('photo generation preferences remain private in published reader data', () => {
  const recipe = structuredClone(recipes[0]);
  recipe.heroPresentation = resolveHeroPresentation(recipe)!;
  assert.equal(Object.hasOwn(toPublicRecipe(recipe), 'heroPresentation'), false);
  assert(recipe.heroPresentation);
});

test('homepage uses the newest public recipe even when an older recipe is featured', () => {
  const newest = toPublicRecipe({ ...recipes[1], featured: false });
  const olderFeatured = toPublicRecipe({ ...recipes[0], featured: true });
  const publications = Object.freeze([newest, olderFeatured]);
  assert.equal(latestPublishedRecipe(publications), newest);
  assert.equal(latestPublishedRecipe(publications)?.slug.pl, newest.slug.pl);
  assert.equal(latestPublishedRecipe(publications)?.slug.en, newest.slug.en);
  assert.deepEqual(publications, [newest, olderFeatured]);
});

test('homepage follows the remaining public publications without a static fallback', () => {
  const older = toPublicRecipe(recipes[0]);
  assert.equal(latestPublishedRecipe([older]), older);
  assert.equal(latestPublishedRecipe([]), undefined);
});

test('public snapshots omit editorial provenance and keep accessible image descriptions', () => {
  const recipe: Recipe = {
    ...recipes[0],
    imageAlt: { pl: 'Ilustracja AI: tagliatelle z bazylią', en: 'AI illustration: tagliatelle with basil' },
    photos: {
      ingredients: { basil: {
        src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 5,
        alt: { pl: 'Ilustracja AI: świeża bazylia', en: 'AI illustration: fresh basil' },
      } },
      steps: { sauce: {
        src: '/images/steps-lemon-pasta.webp', columns: 2, rows: 3, index: 2,
        alt: { pl: 'Ilustracja AI: gładki sos', en: 'AI illustration: smooth sauce' },
        caption: { pl: 'Ilustracja AI: podgrzewaj łagodnie', en: 'AI illustration: warm gently' },
        aspectRatio: 1.5,
      } },
    },
  };
  const original = structuredClone(recipe);
  const displayed = toPublicRecipe(recipe);

  assert.equal(Object.hasOwn(displayed, 'provenance'), false);
  assert.equal(JSON.stringify(displayed).includes('"provenance"'), false);
  assert.deepEqual(displayed.imageAlt, { pl: 'tagliatelle z bazylią', en: 'tagliatelle with basil' });
  assert.deepEqual(displayed.photos?.ingredients.basil.alt, { pl: 'świeża bazylia', en: 'fresh basil' });
  assert.deepEqual(displayed.photos?.steps.sauce.caption, { pl: 'podgrzewaj łagodnie', en: 'warm gently' });
  assert.equal(displayed.photos?.steps.sauce.aspectRatio, 1.5);
  assert.deepEqual(displayed.ingredients, original.ingredients);
  assert.deepEqual(displayed.steps, original.steps);
  assert.deepEqual(recipe, original);
});

test('legacy cake scaling guidance keeps tin and time advice without demo labels', () => {
  const recipe: Recipe = {
    ...recipes.find(item => item.id === 'apple-cake')!,
    scalingNote: {
      pl: 'Kalkulator przelicza składniki, ale nie dobiera formy ani czasu pieczenia. Partia bazowa: 8 porcji, forma 20 cm. Zmiana wielkości wypieku wymaga oceny; przepis demonstracyjny nie ma sprawdzonych wariantów form.',
      en: 'The calculator adjusts ingredients, but does not choose a tin or baking time. Base batch: 8 portions, 20 cm tin. A different batch size needs judgement; this demonstration recipe has no kitchen-tested tin variations.',
    },
  };
  const original = structuredClone(recipe);
  const displayed = toPublicRecipe(recipe);
  assert.equal(displayed.scalingNote?.pl, 'Kalkulator przelicza składniki, ale nie dobiera formy ani czasu pieczenia. Partia bazowa: 8 porcji, forma 20 cm. Zmiana wielkości wypieku wymaga oceny.');
  assert.equal(displayed.scalingNote?.en, 'The calculator adjusts ingredients, but does not choose a tin or baking time. Base batch: 8 portions, 20 cm tin. A different batch size needs judgement.');
  assert.deepEqual(toPublicRecipe({ ...recipe, id: 'a-duplicated-cake' }).scalingNote, displayed.scalingNote);
  assert.deepEqual(recipe, original);
});

test('author image descriptions and captions remain unchanged', () => {
  const recipe: Recipe = {
    ...recipes[0],
    imageAlt: { pl: 'Makaron z sosem i świeżą bazylią', en: 'Pasta with sauce and fresh basil' },
    photos: { ingredients: {}, steps: { sauce: {
      src: '/media/sauce', columns: 1, rows: 1, index: 0,
      alt: { pl: 'Gładki, jasny sos', en: 'Pale, smooth sauce' },
      caption: { pl: 'Sos ma cienko otulać wstążki.', en: 'The sauce should lightly coat the ribbons.' },
    } } },
    scalingNote: { pl: 'Dla większej partii użyj dwóch patelni.', en: 'Use two pans for a larger batch.' },
  };
  const displayed = toPublicRecipe(recipe);
  assert.deepEqual(displayed.imageAlt, recipe.imageAlt);
  assert.deepEqual(displayed.photos, recipe.photos);
  assert.deepEqual(displayed.scalingNote, recipe.scalingNote);
});
