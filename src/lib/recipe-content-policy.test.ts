import assert from 'node:assert/strict';
import test from 'node:test';
import { findRecipeExternalReferences, assertRecipeHasNoExternalReferences } from './recipe-content-policy';
import { recipes } from './recipes';

test('blocks citations, external domains and service attributions across public copy', () => {
  for (const text of [
    'Schłodź w ciągu 2 godzin. ([food.gov.uk](https://www.food.gov.uk/safety-hygiene))',
    'Sprawdź przepis na obcymblogu.pl.', 'Read https://example.cooking/guide.',
    'Podobną konsystencję zaleca Whole Foods Market.', 'W przepisie AGFG smażenie trwa 1–2 minuty.',
    'Według portalu Kulinarne Nowości możesz schłodzić danie.', 'According to New Cooking Site, cool it.',
    'Keep chilled. citeturn0search0', 'Chill immediately. [1]',
    '<a href="//example.com">Read more</a>', 'See www.example.com.',
    'Read [the guide](//example.com/guide).',
    'Zobacz https://ｅｘａｍｐｌｅ.com.', 'Sprawdź exa\u200bmple.com.',
    'Przepis ze strony NowySerwis.', 'Inspired by NYT Cooking.', 'As recommended by Cooking Light.',
  ]) {
    const input = { recipe: { seo: { questions: [{ answer: { en: text } }] } } };
    assert.equal(findRecipeExternalReferences(input).length, 1, text);
    assert.throws(() => assertRecipeHasNoExternalReferences(input), /RECIPE_EXTERNAL_REFERENCE/);
  }
});

test('checks photos, ingredients and substitutions alongside titles, tips and storage', () => {
  const input = { recipe: { title: { en: 'Delish soup' }, storage: { pl: 'Porady food.gov.uk' },
    ingredients: [{ note: { en: 'Read example.com' } }], substitutions: [{ note: { pl: 'Według bloga kuchennego.' } }],
    tips: { en: ['Whole Foods Market recommends this.'] } }, photos: { steps: { boil: { caption: { en: 'Read BBC Good Food' } } } } };
  assert.equal(findRecipeExternalReferences(input).length, 6);
});

test('private research and media addresses stay private and do not block original copy', () => {
  const input = { recipe: { title: { pl: 'Zupa pomidorowa' },
    provenance: { note: { en: 'Adapted from https://example.com' } },
    heroPresentation: { finalAppearance: { en: 'Research https://example.com' } },
    image: 'https://private.blob.vercel-storage.com/image.webp',
    seo: { title: { pl: 'Zupa pomidorowa | jesie.pl' } } },
    sources: [{ title: 'BBC Good Food', url: 'https://example.com' }],
    originalText: 'Source: https://example.com', photos: { steps: { boil: { src: 'https://example.com/image', alt: { pl: 'Zupa w garnku' } } } } };
  assert.deepEqual(findRecipeExternalReferences(input), []);
});

test('ordinary cooking directions, units, abbreviations and own domain are allowed', () => {
  assert.deepEqual(findRecipeExternalReferences(recipes), []);
  for (const text of ['Gotuj według czasu na opakowaniu, m.in. w rondlu.',
    'Use a blender according to the appliance instructions.', 'Choose the quantity according to the variety’s heat.',
    'A comforting bowl of good food. Inspired by autumn flavours.',
    'According to Aunt Krysia, chill the cake first.', 'W przepisie Cioci Krysi ciasto odpoczywa przez godzinę.', 'Bon appétit!',
    'Przechowuj poniżej 5°C przez 2 dni. Podgrzewaj do 75°C przez 0,5 minuty.',
    'Zobacz przepis na jesie.pl oraz https://www.jesie.pl/pl.',
  ]) assert.deepEqual(findRecipeExternalReferences({ description: { pl: text } }), [], text);
});

test('private and technical field names cannot hide captions when used as photo IDs', () => {
  for (const id of ['sources', 'provenance', 'heroPresentation', 'originalText', 'author', 'publication', 'id', 'src', 'image']) {
    for (const kind of ['ingredients', 'steps']) {
      const input = { recipe: { title: { pl: 'Zupa' } }, photos: { [kind]: { [id]: { src: '/media/local', alt: { pl: 'Zobacz https://example.com' } } } } };
      assert.equal(findRecipeExternalReferences(input)[0]?.path, `photos.${kind}.${id}.alt.pl`);
    }
  }
  assert.deepEqual(findRecipeExternalReferences([{ recipe: { provenance: { note: { pl: 'https://example.com' } } }, sources: [{ url: 'https://example.com' }] }]), []);
});
