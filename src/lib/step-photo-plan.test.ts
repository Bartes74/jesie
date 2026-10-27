import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecipeStep } from './recipes';
import { planStepPhotos, stepPhotoPlan } from './step-photo-plan';

function step(id: string, title: string, text: string): RecipeStep {
  return { id, title: { pl: title, en: title }, text: { pl: text, en: text } };
}

test('sauce finishing teaches texture while ordinary plating and serving use the hero', () => {
  const recipe = { steps: [
    step('sauce', 'Finish the sauce', 'Take the pan off the heat. Stir in the butter until glossy and pourable.'),
    step('plate', 'Plate the food', 'Divide between plates and drizzle with the sauce.'),
    step('serve', 'Finish and serve', 'Scatter chopped pistachios over the food. Serve immediately while still warm.'),
  ] };
  const before = structuredClone(recipe);
  const plans = planStepPhotos(recipe);
  assert.deepEqual(plans.map(item => item.required), [true, false, false]);
  assert.equal(plans[0].role, 'texture');
  assert.match(plans[0].objective, /transformation.*texture or consistency/);
  assert.match(plans[0].framing, /without final plating/);
  assert.equal(plans[1].reason, 'finished-presentation');
  assert.deepEqual(recipe, before);
});

test('a serving title cannot hide cooking, setting, packing or structural assembly', () => {
  const plans = planStepPhotos({ steps: [
    step('heat', 'Serve the soup', 'Warm the soup gently for 2 minutes until hot, then ladle into bowls.'),
    step('fold', 'Fill and serve', 'Spread filling over half of each crepe. Fold in half and then again into triangles.'),
    step('bottle', 'Bottle and chill', 'Using a funnel, fill the warm bottle, leaving 1 cm of headspace.'),
    step('set', 'Cool and serve', 'Leave to cool until the filling is firm and set.'),
    step('check', 'Serve the chicken', 'Check that the centre reaches 75°C before serving.'),
  ] });
  assert(plans.every(item => item.required));
  assert.equal(plans[1].role, 'assembly');
  assert.equal(plans[2].role, 'packing');
  assert.equal(plans[3].role, 'setting');
});

test('passive waiting is optional, but a visible rise or set is instructional', () => {
  const plans = planStepPhotos({ steps: [
    step('rest', 'Rest', 'Leave covered for 5 minutes.'),
    step('rise', 'Let the dough rise', 'Leave until doubled in volume.'),
    step('chill', 'Chill', 'Refrigerate until the centre is cold and firm.'),
  ] });
  assert.deepEqual(plans.map(item => item.required), [false, true, true]);
  assert.equal(plans[0].reason, 'passive-wait');
});

test('a meaningful technique in the final step retains its own photograph', () => {
  const recipe = { steps: [
    step('prep', 'Prepare the parcels', 'Fold the dough around the filling and seal firmly.'),
    step('fry', 'Fry until golden', 'Fry until the coating is crisp. Turn with a wide spatula.'),
    step('portion', 'Cut and serve', 'Cut into squares, wiping the knife between cuts. Serve warm.'),
  ] };
  assert(planStepPhotos(recipe).every(item => item.required));
  assert.equal(stepPhotoPlan(recipe, 'portion')?.role, 'preparation');
  assert.equal(stepPhotoPlan(recipe, 'missing'), null);
});

test('Polish-only simple serving is optional and Polish-only cooking stays required', () => {
  const first = step('serve', 'Podaj', 'Podaj od razu. Posyp przygotowaną natką.');
  const second = step('cook', 'Podaj z sosem', 'Podgrzej sos i sprawdź konsystencję. Podaj gorący.');
  first.title.en = first.text.en = second.title.en = second.text.en = '';
  assert.deepEqual(planStepPhotos({ steps: [first, second] }).map(item => item.required), [false, true]);
});

test('unknown instructions remain required instead of guessing that a photo has no value', () => {
  const plans = planStepPhotos({ steps: [step('unknown', 'Finish', 'Use the approved special finishing method.')] });
  assert.equal(plans[0].required, true);
});

test('soup doneness and cheese melting cannot collapse into the same finished ladle photograph', () => {
  const plans = planStepPhotos({ steps: [
    step('gnocchi', 'Cook the gnocchi in the soup', 'Cook until tender. Cut one dumpling in half: it should be hot and soft inside, without a firm centre.'),
    step('cheddar', 'Melt the Cheddar', 'Turn off the heat. Add the Cheddar in small batches, stirring gently and letting each batch melt before adding the next.'),
  ] });
  assert.match(plans[0].objective, /doneness check.*interior/);
  assert.match(plans[1].objective, /melting or incorporation action/);
  assert.notEqual(plans[0].objective, plans[1].objective);
});

test('blending, consistency adjustment and bottling retain three different useful lessons', () => {
  const plans = planStepPhotos({ steps: [
    step('blend', 'Blend the sauce', 'Blend until no discernible pieces remain.'),
    step('balance', 'Balance the consistency', 'Simmer until the sauce coats a spoon but flows freely from it in a thick stream.'),
    step('bottle', 'Bottle the sauce', 'Using a funnel, pour the sauce into the bottle and leave headspace.'),
  ] });
  assert(plans.every(item => item.required));
  assert.match(plans[0].objective, /blender at work/);
  assert.match(plans[1].objective, /texture or consistency/);
  assert.match(plans[2].objective, /filling or packing operation/);
  assert.equal(new Set(plans.map(item => item.objective)).size, 3);
});

test('a passive word in a parcel or portioning instruction cannot make its photograph optional', () => {
  const plans = planStepPhotos({ steps: [
    step('parcel', 'Arrange or seal in parchment', 'Place the fish on the tray. Leave it uncovered or enclose it in a loose parchment parcel, folding the edges tightly shut.'),
    step('portion', 'Chill', 'Divide the dough: two thirds for the base and one third for the topping. Wrap both pieces and chill for 30 minutes.'),
    step('mound', 'Top the crab toasts', 'Spoon the crab mixture onto the toasts. Scatter over chives. Keep the topping in a distinct mound rather than spreading it thinly.'),
  ] });
  assert(plans.every(item => item.required));
});
