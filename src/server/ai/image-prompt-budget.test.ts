import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes, type RecipeStep } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { heroPresentationProfile } from '@/lib/hero-presentation';
import { imageBrief } from './image-prompt';
import { ProviderError } from './provider-error';
import { preflightPhotoPrompts } from './photo-preflight';
import { AiError } from './errors';

const maximumPromptCharacters = 32_000;
const explanation = 'Work carefully and check the result before moving on. The timing is an estimate, so use the described visual checkpoint rather than the clock alone. Prepare the next component while this one rests, keeping the ingredients separate until the method combines them.';

function detailedGlassRecipe(): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.title = { pl: 'Chłodnik migdałowy z winogronami', en: 'Chilled almond soup with grapes' };
  recipe.description = { pl: 'Gładki chłodnik z winogronami i migdałami.', en: 'Smooth chilled soup with grapes and toasted almonds.' };
  recipe.image = '';
  recipe.ingredients = [
    ['almonds', 'blanched almonds'], ['garlic', 'peeled garlic'], ['bread', 'crustless white bread'],
    ['water', 'cold water'], ['oil', 'extra virgin olive oil'], ['vinegar', 'sherry vinegar'],
    ['salt', 'fine salt'], ['grapes', 'seedless green grapes'], ['garnish-almonds', 'toasted chopped almonds'],
  ].map(([id, name]) => ({
    id, name: { pl: name, en: name }, amount: { kind: 'qualitative' as const, text: { pl: 'do smaku', en: 'as needed' } },
    unit: null, scaling: 'linear' as const, group: { pl: '', en: '' },
    note: { pl: 'Przygotuj osobno, zachowując postać wskazaną w instrukcji.', en: 'Prepare separately and retain the form specified by the method; do not add the reserved garnish to the base.' },
  }));
  const stages = [
    ['measure', 'Measure the ingredients', 'Measure the almonds, bread, cold water, oil, vinegar and salt into separate containers. Keep the grapes and the toasted garnish almonds separate from the soup ingredients.'],
    ['peel', 'Peel the garlic', 'Peel the garlic and remove the dry stem end. Leave the peeled cloves whole until the grinding stage; no chopped garlic should appear as a finished topping.'],
    ['soak', 'Soak the bread', 'Tear the crustless bread into small pieces and moisten it with cold water. Leave until soft throughout, then squeeze out the excess water without turning the bread into dry crumbs.'],
    ['toast', 'Toast the garnish almonds', 'Toast only the almonds reserved for the garnish in a dry pan until lightly golden in places. Remove them from the pan so that they stop browning; do not toast the almonds used for the soup base.'],
    ['cool', 'Cool the toasted almonds', 'Spread the toasted almonds on a plate and leave until completely cold. Keep them dry and separate from the wet bread and the soup ingredients.'],
    ['grind', 'Grind the soup almonds', 'Grind the untoasted blanched almonds and peeled garlic in the blender until finely ground. Stop the blender and scrape down the sides before adding the softened bread.'],
    ['blend', 'Blend the soup', 'Add the squeezed bread, sherry vinegar, fine salt and some cold water. Blend the mixture to a uniform smooth cream with no visible almond crumbs. Do not add the reserved grapes or toasted garnish almonds at this stage.'],
    ['emulsify', 'Emulsify the olive oil', 'With the blender running, pour in the olive oil in a thin stream. Continue until the oil is fully incorporated and no separate oil layer remains on the smooth pale soup.'],
    ['adjust', 'Adjust the consistency', 'Add cold water gradually until the soup pours easily but remains creamy. Taste and adjust the salt; the finished base must remain smooth rather than showing bread or garlic pieces.'],
    ['chill', 'Chill the soup', 'Transfer the soup to a covered container and chill until cold throughout. Stir the chilled soup to restore its even consistency before dividing it between the final serving vessels.'],
    ['garnish', 'Prepare the final garnish', 'Cut the seedless green grapes into quarters and chop the cooled toasted almonds. Keep both toppings separate and dry until the soup is ready for immediate serving.'],
    ['serve', 'Serve the finished soup', 'Pour the cold smooth soup into one clear drinking glass. Top the soup with the quartered grapes and chopped toasted almonds. Do not blend these final toppings into the soup.'],
  ];
  recipe.steps = stages.map(([id, title, text]): RecipeStep => ({
    id, title: { pl: title, en: title }, text: { pl: text, en: `${text} ${explanation}` },
  }));
  recipe.heroPresentation = {
    container: 'glass', profileVersion: heroPresentationProfile,
    evidenceStepIds: ['blend', 'emulsify', 'adjust', 'garnish', 'serve'],
    finalAppearance: {
      pl: 'Cały przezroczysty kieliszek z gładkim jasnym chłodnikiem. Na wierzchu ćwiartki zielonych winogron i posiekane prażone migdały.',
      en: 'One complete clear drinking glass containing smooth pale chilled soup. Quartered green grapes and chopped toasted almonds remain visibly separate on the surface; the final toppings are not blended into the soup.',
    },
  };
  return { recipe, originalText: 'Accepted source text remains intact.', author: 'Editor', sources: [],
    photos: { ingredients: {}, steps: {} }, aiPhotography: { heroStyleProfile: heroPresentationProfile } };
}

function fits(prompt: string) {
  assert(Array.from(prompt).length <= maximumPromptCharacters);
  assert(!Buffer.from(prompt).includes(Buffer.from('\uFFFD')), 'No malformed UTF-8 replacement character may be introduced.');
}

test('a detailed twelve-stage accepted recipe exceeds the obsolete byte cap while retaining its complete photographic context', () => {
  const input = detailedGlassRecipe();
  const before = structuredClone(input);
  const brief = 'Show the complete finished glass with the soup and both final toppings clearly visible.';
  assert(Buffer.byteLength(JSON.stringify(input), 'utf8') < 60_000);

  const prompt = imageBrief('hero', input, null, brief);

  fits(prompt);
  assert(Buffer.byteLength(prompt, 'utf8') > 8_000, 'This valid recipe reproduces the obsolete local limit.');
  assert(prompt.includes(input.recipe.heroPresentation!.finalAppearance.en));
  assert(prompt.includes('clear drinking glass'));
  assert(prompt.includes('quartered grapes') || prompt.includes('Quartered green grapes'));
  assert(prompt.includes('chopped toasted almonds'));
  for (const ingredient of input.recipe.ingredients) assert(prompt.includes(ingredient.name.en), ingredient.name.en);
  for (const step of input.recipe.steps) assert(prompt.includes(step.text.en), step.id);
  assert(prompt.endsWith(brief));
  assert.deepEqual(input, before);
});

test('long accepted method context remains complete rather than being silently shortened to the obsolete byte cap', () => {
  const input = detailedGlassRecipe();
  for (const step of input.recipe.steps) {
    step.text.en += ` ${explanation} ${explanation} Reference: [culinary source](https://example.com/recipes/${'method-background-'.repeat(10)}). [1, 2]`;
  }
  const before = structuredClone(input);
  assert(Buffer.byteLength(JSON.stringify(input), 'utf8') < 60_000);

  const prompt = imageBrief('hero', input, null, 'Photograph the accepted finished dish.');

  fits(prompt);
  assert(prompt.includes(input.recipe.heroPresentation!.finalAppearance.en));
  for (const step of input.recipe.steps) assert(prompt.includes(step.text.en), step.id);
  assert.deepEqual(input, before);
});

test('UTF-8 photo instructions remain verbatim without slicing accented text or emoji', () => {
  const input = detailedGlassRecipe();
  const brief = `Kieliszek ma pozostać cały, a winogrona i migdały widoczne. ${'Żółć, źdźbło, łyżeczka 🍇. '.repeat(18)}KONIEC OPISU 🍇`;
  assert(Buffer.byteLength(brief, 'utf8') > brief.length);

  const prompt = imageBrief('hero', input, null, brief);

  fits(prompt);
  assert(prompt.endsWith(brief));
  assert(prompt.includes(input.recipe.heroPresentation!.finalAppearance.en));
});

test('a long recipe preserves the entire current instructional step and excludes later garnishing', () => {
  const input = detailedGlassRecipe();
  const before = structuredClone(input);
  const current = input.recipe.steps.find(step => step.id === 'blend')!;
  const brief = 'Show the blender making the soup base smooth, with no final serving arrangement.';

  const prompt = imageBrief('step', input, current.id, brief);

  fits(prompt);
  assert(prompt.includes(current.text.en), 'The current method must remain complete.');
  assert(prompt.includes('Do not add the reserved grapes or toasted garnish almonds at this stage.'));
  assert.match(prompt, /later[^\n]*(?:not|exclu)|(?:not|exclu)[^\n]*later/i);
  assert.match(prompt, /smooth|blending/i);
  assert(prompt.endsWith(brief));
  assert.deepEqual(input, before);
});

test('manual composition requests keep their vessel and prop instructions alongside a detailed recipe', () => {
  const input = detailedGlassRecipe();
  input.aiPhotography!.regenerate = true;
  const brief = 'Use a low glass on a small wooden board, with one small spoon beside it. Keep the whole board, glass and spoon in the frame; grapes and almonds stay on top.';
  const before = structuredClone(input);

  const prompt = imageBrief('hero', input, null, brief);

  fits(prompt);
  assert(prompt.endsWith(brief));
  assert(prompt.includes(input.recipe.heroPresentation!.finalAppearance.en));
  assert.doesNotMatch(prompt, /captured vessel supersedes|No table, napkin, linen, utensils/);
  assert.match(prompt, /transparent/i);
  assert.deepEqual(input, before);
});

test('an editor brief that exceeds the actual provider contract is rejected rather than silently clipped', () => {
  const input = detailedGlassRecipe();
  const brief = 'Nie usuwaj instrukcji końcowych 🍇. '.repeat(1_100);
  const before = structuredClone(input);
  assert(Array.from(brief).length > maximumPromptCharacters);

  assert.throws(() => imageBrief('hero', input, null, brief), (error: unknown) =>
    error instanceof ProviderError && error.code === 'AI_INPUT_TOO_LARGE');

  assert.deepEqual(input, before);
});

test('the prompt builder accepts exactly 32000 Unicode characters and rejects the next character without clipping', () => {
  const input = detailedGlassRecipe();
  const baseline = imageBrief('hero', input, null, '');
  const remaining = maximumPromptCharacters - Array.from(baseline).length;
  assert(remaining > 0);
  // This directly exercises the provider builder. The separate admission
  // limit for an editor-supplied brief remains independent of this boundary.
  const brief = 'a'.repeat(remaining);

  const prompt = imageBrief('hero', input, null, brief);

  assert.equal(Array.from(prompt).length, maximumPromptCharacters);
  assert(prompt.endsWith(brief));
  assert.throws(() => imageBrief('hero', input, null, `${brief}a`), (error: unknown) =>
    error instanceof ProviderError && error.code === 'AI_INPUT_TOO_LARGE');
});

test('the provider character limit counts astral emoji once rather than as UTF-8 bytes or UTF-16 pairs', () => {
  const input = detailedGlassRecipe();
  const baseline = imageBrief('hero', input, null, '');
  const remaining = maximumPromptCharacters - Array.from(baseline).length;
  const brief = '🍇'.repeat(remaining);

  const prompt = imageBrief('hero', input, null, brief);

  assert.equal(Array.from(prompt).length, maximumPromptCharacters);
  assert(prompt.length > maximumPromptCharacters);
  assert(Buffer.byteLength(prompt, 'utf8') > maximumPromptCharacters);
  assert(prompt.endsWith(brief));
  assert.throws(() => imageBrief('hero', input, null, `${brief}🍇`), (error: unknown) =>
    error instanceof ProviderError && error.code === 'AI_INPUT_TOO_LARGE');
});

test('an over-limit complete method fails preflight before any earlier photograph can be admitted', () => {
  const input = detailedGlassRecipe();
  const longMethod = 'Continue checking the cooking result without adding the reserved garnish. '.repeat(240);
  assert(longMethod.length < 20_000);
  input.recipe.steps[0].text.en += ` ${longMethod}`;
  input.recipe.steps[1].text.en += ` ${longMethod}`;
  const before = structuredClone(input);
  assert(Buffer.byteLength(JSON.stringify(input), 'utf8') < 60_000);
  const slots = [
    { kind: 'ingredient' as const, targetId: 'almonds', brief: 'Show the blanched almonds.' },
    { kind: 'hero' as const, targetId: null, brief: 'Show the finished soup and all toppings.' },
  ];
  assert.doesNotThrow(() => imageBrief('ingredient', input, 'almonds', slots[0].brief));
  let admitted = 0;

  assert.throws(() => {
    preflightPhotoPrompts(input, slots);
    slots.forEach(() => { admitted++; });
  }, (error: unknown) => {
    assert(error instanceof AiError);
    assert.equal(error.code, 'PHOTO_PROMPT_INVALID');
    assert.match(error.message, /32000 znaków/);
    assert.doesNotMatch(error.message, /8000|bajtów/);
    return true;
  });

  assert.equal(admitted, 0);
  assert.deepEqual(input, before);
});
