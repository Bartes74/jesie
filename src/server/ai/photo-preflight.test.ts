import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EditorialContent } from '@/lib/editorial-types';
import { heroPresentationProfile } from '@/lib/hero-presentation';
import { recipes, type RecipeStep } from '@/lib/recipes';
import { AiError } from './errors';
import { imageBrief, imagePromptMaxCharacters } from './image-prompt';
import { paperIngredientStyleProfile } from './ingredient-profile';
import { preflightPhotoPrompts, type PhotoPromptSlot } from './photo-preflight';

test('an empty photo plan never blocks receipt-only recovery or reuse of completed photographs', () => {
  const input = recipeWithTwelveStages();
  input.originalText = 'a'.repeat(70_000);
  assert.doesNotThrow(() => preflightPhotoPrompts(input, []));
});

function recipeWithTwelveStages(): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.title = { pl: 'Risotto z pieczoną dynią', en: 'Roasted squash risotto' };
  recipe.description = { pl: 'Kremowe risotto z miękką dynią.', en: 'Creamy risotto with tender squash.' };
  recipe.image = '';
  recipe.ingredients = [
    { id: 'squash', name: { pl: 'Dynia', en: 'Squash' }, amount: { kind: 'exact', value: '400' }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' } },
    { id: 'rice', name: { pl: 'Ryż do risotto', en: 'Risotto rice' }, amount: { kind: 'exact', value: '200' }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' } },
  ];
  const stages = [
    ['Rozgrzej piekarnik', 'Preheat the oven', 'Rozgrzej piekarnik do 200°C.', 'Preheat the oven to 200°C.'],
    ['Pokrój dynię', 'Cut the squash', 'Pokrój {{squash}} dyni w równe kostki.', 'Cut {{squash}} of squash into even cubes.'],
    ['Rozłóż dynię', 'Spread the squash', 'Rozłóż dynię w jednej warstwie na blasze.', 'Spread the squash in a single layer on a tray.'],
    ['Upiecz dynię', 'Roast the squash', 'Piecz 25 minut, aż widelec łatwo wejdzie w miąższ.', 'Roast for 25 minutes until a fork slides easily into the flesh.'],
    ['Podgrzej wodę', 'Heat the water', 'Podgrzej 700 ml wody do lekkiego wrzenia.', 'Bring 700 ml of water to a gentle simmer.'],
    ['Rozgrzej garnek', 'Warm the pan', 'Rozgrzej pusty garnek na średnim ogniu.', 'Warm an empty pan over a medium heat.'],
    ['Podpraż ryż', 'Toast the rice', 'Wsyp {{rice}} ryżu i mieszaj 2 minuty.', 'Add {{rice}} of rice and stir for 2 minutes.'],
    ['Zwilż ryż', 'Moisten the rice', 'Wlej chochlę gorącej wody; płyn powinien delikatnie bulgotać.', 'Add a ladle of hot water; the liquid should bubble gently.'],
    ['Ugotuj ryż', 'Cook the rice', 'Dolewaj wodę porcjami przez 18 minut, aż ryż będzie jędrny w środku.', 'Add water gradually for 18 minutes until the rice has a firm centre.'],
    ['Dodaj dynię', 'Fold in the squash', 'Delikatnie wmieszaj dynię, zachowując całe kostki.', 'Gently fold in the squash, keeping the cubes intact.'],
    ['Odstaw risotto', 'Rest the risotto', 'Zdejmij z ognia na 2 minuty; risotto powinno swobodnie spływać z łyżki.', 'Rest off the heat for 2 minutes; the risotto should flow gently from a spoon.'],
    ['Podaj', 'Serve', 'Przełóż na talerz i podawaj od razu.', 'Transfer to a plate and serve immediately.'],
  ];
  recipe.steps = stages.map(([plTitle, enTitle, pl, en], index): RecipeStep => ({
    id: `stage-${index + 1}`, title: { pl: plTitle, en: enTitle }, text: { pl, en },
  }));
  recipe.heroPresentation = {
    profileVersion: heroPresentationProfile, container: 'plate', evidenceStepIds: ['stage-12'],
    finalAppearance: { pl: 'Kremowe risotto z całymi kawałkami dyni.', en: 'Creamy risotto with intact squash cubes.' },
  };
  return {
    recipe, originalText: 'Prywatne notatki autora.', author: 'Autorka', sources: [],
    photos: { ingredients: {}, steps: {} },
    aiPhotography: { ingredientStyleProfile: paperIngredientStyleProfile, heroStyleProfile: heroPresentationProfile },
  };
}

function allSlots(input: EditorialContent): PhotoPromptSlot[] {
  return [
    ...input.recipe.ingredients.map(item => ({ kind: 'ingredient' as const, targetId: item.id, brief: 'Show the ingredient in its required form.' })),
    ...input.recipe.steps.map(item => ({ kind: 'step' as const, targetId: item.id, brief: 'Show the state at the end of this stage.' })),
    { kind: 'hero', targetId: null, brief: 'Show the finished food and complete plate.' },
  ];
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof AiError && error.status === 422 && error.code === code;
}

test('all prompts for twelve meaningful cooking stages fit without changing the content or plan', () => {
  const input = recipeWithTwelveStages();
  const slots = allSlots(input);
  const originalInput = structuredClone(input);
  const originalSlots = structuredClone(slots);
  assert.equal(input.recipe.steps.length, 12);
  assert.equal(slots.filter(slot => slot.kind === 'step').length, 12);

  assert.doesNotThrow(() => preflightPhotoPrompts(input, slots));

  assert.deepEqual(input, originalInput);
  assert.deepEqual(slots, originalSlots);
});

test('oversized later cooking context rejects the whole plan before the first fake admission', () => {
  const input = recipeWithTwelveStages();
  for (const step of input.recipe.steps.slice(-5)) {
    step.text.en += ' Keep checking the final consistency before serving.'.repeat(135);
    assert(step.text.en.length < 20_000);
  }
  const slots = allSlots(input);
  assert(Buffer.byteLength(JSON.stringify(input), 'utf8') < 60_000);
  assert.doesNotThrow(() => imageBrief('ingredient', input, 'squash', slots[0].brief));
  let admitted = 0;
  const admit = () => {
    preflightPhotoPrompts(input, slots);
    slots.forEach(() => { admitted++; });
  };

  assert.throws(admit, errorCode('PHOTO_PROMPT_INVALID'));
  assert.equal(admitted, 0);
});

test('an unknown ingredient token identifies the affected method step without exposing private instructions', () => {
  const input = recipeWithTwelveStages();
  const privateMarker = 'PRIVATE_METHOD_DO_NOT_ECHO';
  input.recipe.steps[2].text.en = `Add {{butter}} of butter. ${privateMarker}`;
  let admitted = 0;
  assert.throws(() => {
    preflightPhotoPrompts(input, allSlots(input));
    admitted++;
  }, (error: unknown) => {
    assert(errorCode('PHOTO_PROMPT_INVALID')(error));
    assert(error instanceof AiError);
    assert.match(error.message, /krok 3.*brakującego składnika „butter”/);
    assert.doesNotMatch(error.message, new RegExp(privateMarker));
    assert.doesNotMatch(error.message, /Prywatne notatki/);
    return true;
  });
  assert.equal(admitted, 0);
});

test('unexpected prompt rendering errors remain unexpected errors', () => {
  const input = recipeWithTwelveStages();
  input.recipe.ingredients[0].amount = { kind: 'exact', value: 'not-a-number' };
  assert.throws(() => preflightPhotoPrompts(input, allSlots(input)), (error: unknown) => error instanceof Error && !(error instanceof AiError) && !(error.message.startsWith('Unknown ingredient token ')));
});

test('a failing hero prompt at the end prevents admission of all earlier valid photos', () => {
  const input = recipeWithTwelveStages();
  const slots = allSlots(input);
  const privateMarker = 'PRIVATE_PHOTO_BRIEF_DO_NOT_ECHO';
  // Make only the last slot invalid. Step continuity prompts may contain more
  // context than hero prompts, so shared method padding cannot isolate the hero.
  slots.at(-1)!.brief = `${privateMarker}${'a'.repeat(imagePromptMaxCharacters)}`;
  assert(Buffer.byteLength(JSON.stringify(input), 'utf8') < 60_000);
  assert.doesNotThrow(() => preflightPhotoPrompts(input, slots.slice(0, -1)));
  let admitted = 0;

  assert.throws(() => {
    preflightPhotoPrompts(input, slots);
    admitted++;
  }, (error: unknown) => {
    assert(errorCode('PHOTO_PROMPT_INVALID')(error));
    assert(error instanceof AiError);
    assert.doesNotMatch(error.message, new RegExp(privateMarker));
    return true;
  });
  assert.equal(admitted, 0);
});

test('the complete captured input has a 60 kB guard even when its planned prompt is short', () => {
  const input = recipeWithTwelveStages();
  input.originalText = 'Private source material. '.repeat(3_000);
  const slot: PhotoPromptSlot = { kind: 'ingredient', targetId: 'squash', brief: 'Show the raw ingredient.' };
  assert.doesNotThrow(() => imageBrief(slot.kind, input, slot.targetId ?? null, slot.brief));
  assert(Buffer.byteLength(JSON.stringify(input), 'utf8') > 60_000);

  assert.throws(() => preflightPhotoPrompts(input, [slot]), errorCode('PHOTO_INPUT_TOO_LARGE'));
});

test('the captured input limit counts UTF-8 bytes rather than JavaScript characters', () => {
  const input = recipeWithTwelveStages();
  input.originalText = 'ą'.repeat(1_000);
  const serialized = JSON.stringify(input);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const limitBetweenCharactersAndBytes = Math.floor((serialized.length + bytes) / 2);
  const slots: PhotoPromptSlot[] = [{ kind: 'ingredient', targetId: 'squash', brief: 'Raw squash.' }];
  assert(serialized.length < limitBetweenCharactersAndBytes);
  assert(limitBetweenCharactersAndBytes < bytes);

  assert.throws(() => preflightPhotoPrompts(input, slots, limitBetweenCharactersAndBytes), errorCode('PHOTO_INPUT_TOO_LARGE'));
  assert.doesNotThrow(() => preflightPhotoPrompts(input, slots, bytes));
});

test('provider prompt limits count Unicode characters while the capture guard still counts bytes', () => {
  const input = recipeWithTwelveStages();
  const baseline = imageBrief('ingredient', input, 'squash', '');
  const characters = imagePromptMaxCharacters - Array.from(baseline).length;
  assert(characters > 0);
  const slot: PhotoPromptSlot = { kind: 'ingredient', targetId: 'squash', brief: 'a'.repeat(characters) };
  assert.doesNotThrow(() => preflightPhotoPrompts(input, [slot]));
  slot.brief = 'ą'.repeat(characters);
  assert(Buffer.byteLength(imageBrief(slot.kind, input, slot.targetId ?? null, slot.brief), 'utf8') > imagePromptMaxCharacters);
  assert.doesNotThrow(() => preflightPhotoPrompts(input, [slot]));
  slot.brief += 'ą';
  let admitted = 0;

  assert.throws(() => {
    preflightPhotoPrompts(input, [slot]);
    admitted++;
  }, (error: unknown) => {
    assert(errorCode('PHOTO_PROMPT_INVALID')(error));
    assert(error instanceof AiError);
    assert.match(error.message, /32000 znaków/);
    assert.doesNotMatch(error.message, /8000|bajtów/);
    return true;
  });
  assert.equal(admitted, 0);
});
