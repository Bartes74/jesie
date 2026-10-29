import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { heroContainers, heroPresentationProfile } from '@/lib/hero-presentation';
import { imageBrief } from './image-prompt';
import { paperIngredientStyleProfile } from './ingredient-profile';

function butterInput(): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.title = { pl: 'Masło palone z suszonymi pomidorami', en: 'Brown butter with sun-dried tomatoes' };
  recipe.steps = [{ id: 'serve', title: { pl: 'Podaj', en: 'Serve' }, text: { pl: 'Podaj ciepłe masło w sosjerce.', en: 'Serve the warm liquid butter in a sauce boat.' } }];
  recipe.heroPresentation = {
    container: 'sauceboat', profileVersion: heroPresentationProfile, evidenceStepIds: ['serve'],
    finalAppearance: { pl: 'Ciepłe, płynne masło w sosjerce.', en: 'Warm, liquid butter in a sauce boat.' },
  };
  return { recipe, originalText: '', author: '', sources: [], photos: { ingredients: {}, steps: {} },
    aiPhotography: { heroStyleProfile: heroPresentationProfile, regenerate: true } };
}

test('a manual serving-board retake keeps the complete requested composition without conflicting vessel or prop bans', () => {
  const input = butterInput();
  const before = structuredClone(input);
  const brief = 'Na drewnianej deseczce leży gotowe masło ukształtowane w quenelle. Obok leży klasyczny nożyk do masła.';
  const prompt = imageBrief('hero', input, null, brief);
  assert(prompt.endsWith(brief));
  assert.match(prompt, /editor’s requested vessel or serving surface takes priority/);
  assert.match(prompt, /Cooling or shaping the prepared food for serving is allowed when requested/);
  assert.match(prompt, /every requested utensil visible with comfortable margins/);
  assert.match(prompt, /fully transparent exterior background around the complete composition/);
  assert.match(prompt, /no additional scenery/);
  assert.doesNotMatch(prompt, /captured vessel supersedes|brief cannot change|No table, napkin, linen, utensils/);
  assert.deepEqual(input, before);
});

test('automatic photographs keep their captured vessel and prop restrictions', () => {
  const input = butterInput();
  delete input.aiPhotography!.regenerate;
  const prompt = imageBrief('hero', input, null, 'Fotografia gotowej potrawy.');
  assert.match(prompt, /captured vessel supersedes conflicting vessel wording/);
  assert.match(prompt, /No table, napkin, linen, utensils, decorative props/);
  assert.doesNotMatch(prompt, /Cooling or shaping|every requested utensil/);
});

test('finished-dish photographs exclude exterior shadows for every approved vessel while retaining material shading and glass', () => {
  for (const container of heroContainers) {
    const input = butterInput();
    delete input.aiPhotography!.regenerate;
    input.recipe.heroPresentation!.container = container;
    const before = structuredClone(input);
    const prompt = imageBrief('hero', input, null, 'Fotografia gotowej potrawy.');
    assert.match(prompt, /no external cast shadow, ground shadow, contact shadow or drop shadow/);
    assert.match(prompt, /fully transparent immediately outside the true silhouette/);
    assert.match(prompt, /preserve their natural internal shading, texture, highlights and reflections/);
    assert.match(prompt, /Preserve real glass transparency/);
    assert.match(prompt, /Do not erase translucent glass to remove a shadow/);
    assert(prompt.includes(input.recipe.heroPresentation!.finalAppearance.en));
    assert.deepEqual(input, before);
  }
});

test('legacy and manually restaged heroes keep a shadowless exterior without changing their requested food and props', () => {
  const input = butterInput();
  const brief = 'Gotowe masło na deseczce z nożykiem i cieniem pod deseczką.';
  for (const legacy of [false, true]) {
    if (legacy) delete input.aiPhotography;
    const prompt = imageBrief('hero', input, null, brief);
    assert.match(prompt, /These exterior-format constraints also apply when the recipe or editorial brief mentions a cast shadow/);
    assert(prompt.endsWith(brief));
  }
});

test('the finished-dish shadow policy does not flatten instructional steps or remove opaque ingredient contact shadows', () => {
  const input = butterInput();
  const step = imageBrief('step', input, 'serve', 'Show serving.');
  assert.doesNotMatch(step, /Finished-dish cutout format|no external cast shadow/);
  assert.match(step, /Metal rings, moulds, baking trays, sheet pans, pots, pans, dishes and other opaque cookware stay solid around their full height and across their whole surface/);
  input.aiPhotography = { ingredientStyleProfile: paperIngredientStyleProfile };
  const ingredient = imageBrief('ingredient', input, input.recipe.ingredients[0].id, 'Show the ingredient.');
  assert.match(ingredient, /natural soft contact shadow/);
  assert.doesNotMatch(ingredient, /Finished-dish cutout format|no external cast shadow/);
});

test('successive sauce, packing and serving images receive distinct teaching objectives', () => {
  const input = butterInput();
  input.recipe.steps = [
    { id: 'finish', title: { pl: 'Wykończ sos', en: 'Finish the sauce' }, text: { pl: 'Mieszaj, aż sos będzie błyszczący.', en: 'Stir until the sauce is glossy and coats a spoon.' } },
    { id: 'bottle', title: { pl: 'Napełnij butelkę', en: 'Bottle and chill' }, text: { pl: 'Przelej przez lejek.', en: 'Use a funnel to fill the bottle, leaving 1 cm of headspace.' } },
    { id: 'serve', title: { pl: 'Podaj', en: 'Serve' }, text: { pl: 'Podaj od razu.', en: 'Serve straight away.' } },
  ];
  input.recipe.image = '/media/existing-hero';
  const before = structuredClone(input);
  const finish = imageBrief('step', input, 'finish', 'Show this step.');
  const bottle = imageBrief('step', input, 'bottle', 'Show this step.');
  const serve = imageBrief('step', input, 'serve', 'Show this step.');
  assert.match(finish, /Teach the current transformation/);
  assert.match(finish, /without final plating/);
  assert.match(bottle, /Teach the filling or packing operation/);
  assert.match(bottle, /not another photograph of the closed finished container/);
  assert.match(serve, /separate photograph is optional/);
  for (const prompt of [finish, bottle, serve]) {
    assert.match(prompt, /decisive action or visible completion checkpoint/);
    assert.match(prompt, /Do not repeat an unchanged finished dish with a different angle/);
    assert.match(prompt, /finished-dish photograph is not supplied as an image reference/);
    assert.doesNotMatch(prompt, /END of the current step|natural ceramic and linen|shallow depth of field/);
    assert(Buffer.byteLength(prompt, 'utf8') <= 8_000);
  }
  assert.deepEqual(input, before);
});

function eggsInput(): EditorialContent {
  const input = butterInput();
  input.recipe.title = { pl: 'Jajka faszerowane miso', en: 'Miso devilled eggs' };
  input.recipe.baseServings = 4;
  input.recipe.ingredients = [
    { id: 'eggs', name: { pl: 'obrane jajka ugotowane na twardo', en: 'peeled hard-boiled eggs' }, amount: { kind: 'exact', value: '2' }, unit: 'count', scaling: 'linear', group: { pl: '', en: '' } },
    { id: 'soy', name: { pl: 'sos sojowy', en: 'soy sauce' }, amount: { kind: 'range', min: '1', max: '2' }, unit: 'tbsp', scaling: 'linear', group: { pl: '', en: '' } },
    { id: 'nori', name: { pl: 'nori', en: 'nori' }, amount: { kind: 'exact', value: '1' }, unit: 'count', scaling: 'linear', group: { pl: '', en: '' } },
  ];
  input.recipe.steps = [
    { id: 'marinate', title: { pl: 'Zamarynuj', en: 'Marinate' }, text: { pl: 'Zamarynuj całe jajka w sosie sojowym.', en: 'Marinate the whole eggs in soy sauce until the whites have a light brown tint.' } },
    { id: 'halve', title: { pl: 'Przekrój', en: 'Halve' }, text: { pl: 'Przekrój jajka wzdłuż i wyjmij żółtka.', en: 'Cut the eggs in half lengthways and remove the yolks.' } },
    { id: 'fill', title: { pl: 'Napełnij', en: 'Fill' }, text: { pl: 'Napełnij białka kremem.', en: 'Pipe the yellow-beige filling into the whites, making small mounds.' } },
    { id: 'chill', title: { pl: 'Schłodź', en: 'Chill' }, text: { pl: 'Schłodź pod przykryciem.', en: 'Chill the covered platter until the filling holds its shape.' } },
    { id: 'serve', title: { pl: 'Udekoruj', en: 'Garnish' }, text: { pl: 'Dodaj nori dopiero przed podaniem.', en: 'Add nori just before serving.' } },
  ];
  input.recipe.heroPresentation = {
    container: 'platter', profileVersion: heroPresentationProfile, evidenceStepIds: ['marinate', 'fill', 'serve'],
    finalAppearance: { pl: 'Cztery połówki na półmisku, lekko sojowe białka, żółtobeżowy krem i nori.', en: 'Four egg halves on a platter, with light brown soy-tinted whites, yellow-beige filling and nori.' },
  };
  return input;
}

test('egg step prompts retain two whole eggs as the base batch and derive four halves only after cutting', () => {
  const input = eggsInput();
  const before = structuredClone(input);
  for (const step of input.recipe.steps) {
    const prompt = imageBrief('step', input, step.id, 'Show this recipe batch.');
    assert.match(prompt, /Base batch: 4 recipe servings\. Servings are not a count of whole ingredients or pieces/);
    assert.match(prompt, /peeled hard-boiled eggs: 2 pcs/);
    assert.match(prompt, /soy sauce: 1–2 tbsp/);
    assert.match(prompt, /Never enlarge the batch for composition, add duplicate pieces/);
    assert.match(prompt, /no visible or implied total may exceed this batch/);
    assert.match(prompt, /Derive whole-item and cut-piece counts from the ingredient quantities and transformations already performed/);
    assert(prompt.includes(input.recipe.heroPresentation!.finalAppearance.en));
    assert.match(prompt, /rather than applying the final piece shape before it is made/);
  }
  const marinate = imageBrief('step', input, 'marinate', 'Show marinating.');
  assert(marinate.indexOf('Current step 1') < marinate.indexOf('Later steps NOT performed yet'));
  assert(marinate.indexOf('Later steps NOT performed yet') < marinate.indexOf('Cut the eggs in half lengthways'));
  assert.deepEqual(input, before);
});

test('later egg stages retain soy colour while approved final toppings remain subject to stage boundaries', () => {
  const input = eggsInput();
  const prompt = imageBrief('step', input, 'fill', 'Show filling the whites.');
  assert(prompt.includes('Earlier steps already completed:\n1. Marinate: Marinate the whole eggs in soy sauce until the whites have a light brown tint.'));
  assert.match(prompt, /Carry forward all earlier visible changes in colour, coating, doneness, shape and texture/);
  assert.match(prompt, /do not reset the food to its raw or pre-treatment appearance/);
  assert.match(prompt, /retain that colour in subsequent stages/);
  assert.match(prompt, /Apply only the appearance attributes whose cause has occurred in an earlier step or occurs in this step/);
  assert.match(prompt, /Keep later filling, garnish, plating and other future transformations absent until their method step/);
  const future = prompt.slice(prompt.indexOf('Later steps NOT performed yet'), prompt.indexOf('Stage boundary:'));
  assert(future.includes('Add nori just before serving.'));
});

test('the same quantity and appearance contract handles other piece counts without egg assumptions', () => {
  const input = eggsInput();
  input.recipe.title = { pl: 'Papryki faszerowane', en: 'Stuffed peppers' };
  input.recipe.baseServings = 6;
  input.recipe.ingredients = [
    { id: 'peppers', name: { pl: 'czerwone papryki', en: 'red peppers' }, amount: { kind: 'exact', value: '3' }, unit: 'count', scaling: 'linear', group: { pl: '', en: '' } },
  ];
  input.recipe.steps = [
    { id: 'halve', title: { pl: 'Przekrój', en: 'Halve' }, text: { pl: 'Przekrój papryki na połówki.', en: 'Cut each pepper lengthways into two halves.' } },
    { id: 'bake', title: { pl: 'Upiecz', en: 'Bake' }, text: { pl: 'Upiecz do zrumienienia.', en: 'Bake until the edges are browned.' } },
  ];
  input.recipe.heroPresentation = {
    container: 'baking-dish', profileVersion: heroPresentationProfile, evidenceStepIds: ['bake'],
    finalAppearance: { pl: 'Sześć połówek czerwonej papryki ze zrumienionymi brzegami.', en: 'Six red pepper halves with browned edges.' },
  };
  const prompt = imageBrief('step', input, 'bake', 'Show the completion checkpoint.');
  assert.match(prompt, /Base batch: 6 recipe servings/);
  assert.match(prompt, /red peppers: 3 pcs/);
  assert(prompt.includes('Six red pepper halves with browned edges.'));
  assert(prompt.includes('Cut each pepper lengthways into two halves.'));
  assert.doesNotMatch(prompt, /egg|soy|Four egg/iu);
});
