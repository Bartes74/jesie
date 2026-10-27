import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes, type IngredientSubstitution } from '../../lib/recipes';
import type { EditorialContent } from '../../lib/editorial-types';
import { getIngredientImage, getStepImage } from '../../lib/recipe-media';
import { editorialContentSchema, publicationIssues } from './validation';
import { heroPresentationProfile, suggestHeroPresentation } from '../../lib/hero-presentation';

function content(substitution: Partial<IngredientSubstitution> = {}): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.substitutions = [{ id: 'alternative', ingredientId: recipe.ingredients[0].id,
    name: { pl: 'Makaron penne', en: 'Penne pasta' },
    note: { pl: 'Gotuj według opakowania; sos zostaje taki sam.', en: 'Follow the packet cooking time; use the same sauce.' },
    amount: { kind: 'exact', value: '250' }, unit: 'g', scaling: 'linear', status: 'approved', ...substitution }];
  return { recipe, originalText: '', author: 'Autor', sources: [], photos: {
    ingredients: Object.fromEntries(recipe.ingredients.map(item => [item.id, getIngredientImage(recipe.id, item.id)])),
    steps: Object.fromEntries(recipe.steps.map(item => [item.id, getStepImage(recipe.id, item.id)])),
  } };
}
const issues = (value: EditorialContent) => publicationIssues(value).filter(issue => issue.field.startsWith('substitutions.'));

test('publication rejects external citations in copy and photo captions while allowing private sources', () => {
  const value = content();
  value.recipe.storage.en = 'Refrigerate for 2 days. ([food.gov.uk](https://food.gov.uk/guide))';
  value.photos.steps[value.recipe.steps[0].id].caption = { pl: 'Gotowe danie.', en: 'See BBC Good Food.' };
  value.sources = [{ id: 'source', title: 'BBC Good Food', url: 'https://bbcgoodfood.com' }];
  const errors = publicationIssues(value);
  assert(errors.some(issue => issue.field === 'storage.en'));
  assert(errors.some(issue => issue.field.startsWith('photos.steps.')));
  assert(!errors.some(issue => issue.field.startsWith('sources.')));
});

test('publication accepts separate canonical citrus photos and rejects old, swapped and duplicate crops', () => {
  const value=content();
  assert(!publicationIssues(value).some(issue=>issue.field==='ingredients.lemon-juice.photo'||issue.field==='ingredients.lemon-zest.photo'));
  value.photos.ingredients['lemon-juice']={src:'/images/ingredients-1.webp',columns:4,rows:3,index:4,alt:{pl:'Sok',en:'Juice'}};
  assert(publicationIssues(value).some(issue=>issue.field==='ingredients.lemon-juice.photo'));
  value.photos.ingredients['lemon-juice']={...value.photos.ingredients['lemon-zest']};
  assert(publicationIssues(value).some(issue=>issue.field==='ingredients.lemon-juice.photo'));
  const shared={src:'/media/citrus',columns:1,rows:1,index:0,alt:{pl:'Cytryna',en:'Lemon'}};
  value.photos.ingredients['lemon-juice']=shared;value.photos.ingredients['lemon-zest']=shared;
  const registered=new Map([['/media/citrus','ingredient' as const]]);
  assert(publicationIssues(value,registered).some(issue=>issue.message.includes('tego samego zdjęcia')));
  delete value.photos.ingredients['lemon-zest'];
  assert(publicationIssues(value,registered,new Map([['/media/citrus','zest']])).some(issue=>issue.field==='ingredients.lemon-juice.photo'&&issue.message.includes('zdjęcia soku')));
  assert(editorialContentSchema.safeParse(value).success,'Legacy snapshots remain shape-readable; semantic policy applies to writes/publication.');
});

test('kitchen testing requires a real date, tester and result while remaining private editorial data', () => {
  const value = content(); value.recipe.provenance.kitchenTested = true;
  assert(publicationIssues(value).some(issue => issue.field === 'provenance.kitchenTested'));
  value.kitchenTest = { date: '2026-02-30', tester: 'Redaktor', notes: 'Próba w kuchni' };
  assert(publicationIssues(value).some(issue => issue.field === 'provenance.kitchenTested'));
  value.kitchenTest.date = '2026-10-12';
  assert(!publicationIssues(value).some(issue => issue.field === 'provenance.kitchenTested'));
  assert.deepEqual(editorialContentSchema.parse(value).kitchenTest, value.kitchenTest);
});

test('SEO fields survive parsing without replacing recipe data; public questions need both languages', () => {
  const value = content();
  value.recipe.seo = { title: { pl: 'Makaron na obiad', en: '' }, collectionIds: ['one-pot'], relatedRecipeIds: ['another'], questions: [{ id: 'question-1', question: { pl: 'Jaki makaron?', en: '' }, answer: { pl: 'Ten wskazany w składnikach.', en: '' } }] };
  assert.deepEqual(editorialContentSchema.parse(value).recipe.seo, value.recipe.seo);
  assert(publicationIssues(value).some(issue => issue.field === 'seo.questions.question-1.en'));
  assert.equal(editorialContentSchema.parse(value).recipe.title.pl, value.recipe.title.pl);
});

test('approved substitutions preserve optional justified quantity, including no numeric equivalence', () => {
  assert.deepEqual(issues(content()), []);
  assert.deepEqual(issues(content({ amount: undefined, unit: undefined })), []);
  const legacy = content(); delete legacy.recipe.substitutions; delete legacy.recipe.collection;
  assert(editorialContentSchema.safeParse(legacy).success);
});

test('an approved substitute must have a valid target and bilingual technique guidance', () => {
  assert(issues(content({ ingredientId: 'deleted' })).length > 0);
  assert(issues(content({ note: { pl: 'Gotuj dłużej.', en: '' } })).some(issue => issue.field.endsWith('.en')));
  assert(issues(content({ name: { pl: '', en: 'Penne' } })).some(issue => issue.field.endsWith('.pl')));
});

test('approved quantities reject zero, reversed ranges and unsupported unit combinations', () => {
  for (const amount of [{ kind: 'exact', value: '0' }, { kind: 'range', min: '10', max: '5' }] as const) {
    assert(issues(content({ amount })).some(issue => issue.field.endsWith('.amount')));
  }
  assert(issues(content({ unit: null })).some(issue => issue.field.endsWith('.unit')));
  assert(issues(content({ amount: undefined, unit: 'g' })).some(issue => issue.field.endsWith('.unit')));
  assert(issues(content({ amount: { kind: 'qualitative', text: { pl: 'do smaku', en: 'to taste' } }, unit: 'g' })).some(issue => issue.field.endsWith('.unit')));
});

test('pending alternatives may remain in a draft, but become validated at human acceptance', () => {
  const draft = content({ status: 'to_review', name: { pl: '', en: '' }, amount: { kind: 'exact', value: '0' } });
  assert(editorialContentSchema.safeParse(draft).success);
  assert.deepEqual(issues(draft), []);
  draft.recipe.substitutions![0].status = 'approved';
  assert(issues(draft).length >= 3);
});

test('duplicate substitution IDs and dangling pending targets cannot pass publication validation', () => {
  const duplicate = content(); duplicate.recipe.substitutions!.push(structuredClone(duplicate.recipe.substitutions![0]));
  assert(issues(duplicate).some(issue => issue.message.includes('powtarza')));
  assert(issues(content({ ingredientId: 'removed', status: 'to_review' })).length > 0);
});

test('hero presentation survives draft validation with a server-assigned profile version', () => {
  const value = content();
  value.recipe.heroPresentation = suggestHeroPresentation(value.recipe)!;
  const parsed = editorialContentSchema.parse(value);
  assert.deepEqual(parsed.recipe.heroPresentation, value.recipe.heroPresentation);
  const withoutVersion = structuredClone(value) as unknown as { recipe: { heroPresentation: { profileVersion?: string } } };
  delete withoutVersion.recipe.heroPresentation.profileVersion;
  assert.equal(editorialContentSchema.parse(withoutVersion).recipe.heroPresentation?.profileVersion, heroPresentationProfile);
  const legacy = content();
  assert.equal(editorialContentSchema.parse(legacy).recipe.heroPresentation, undefined);
});

test('incomplete presentation can be saved as a draft but not published', () => {
  const value = content();
  value.recipe.heroPresentation = { container: 'jar', finalAppearance: { pl: '', en: '' }, evidenceStepIds: [], profileVersion: heroPresentationProfile };
  assert(editorialContentSchema.safeParse(value).success);
  assert(publicationIssues(value).some(issue => issue.field === 'heroPresentation'));
});

test('explicit unresolved AI presentation remains null through draft parsing and blocks publication', () => {
  const value = content();
  value.recipe.heroPresentation = null;
  const parsed = editorialContentSchema.parse(value);
  assert.equal(parsed.recipe.heroPresentation, null);
  assert(publicationIssues(parsed).some(issue => issue.field === 'heroPresentation'));
  delete value.recipe.heroPresentation;
  assert.equal(editorialContentSchema.parse(value).recipe.heroPresentation, undefined);
  assert(!publicationIssues(value).some(issue => issue.field === 'heroPresentation'));
});

test('presentation evidence must still refer to unique existing preparation steps', () => {
  const value = content();
  value.recipe.heroPresentation = suggestHeroPresentation(value.recipe)!;
  assert(!publicationIssues(value).some(issue => issue.field === 'heroPresentation'));
  value.recipe.heroPresentation.evidenceStepIds = ['deleted'];
  assert(publicationIssues(value).some(issue => issue.field === 'heroPresentation' && issue.message.includes('usunięty')));
  value.recipe.heroPresentation.evidenceStepIds = [value.recipe.steps[0].id, value.recipe.steps[0].id];
  assert(publicationIssues(value).some(issue => issue.field === 'heroPresentation' && issue.message.includes('powtarzać')));
});

test('presentation schema rejects unsupported vessels, profile changes and overlong descriptions', () => {
  const value = content();
  value.recipe.heroPresentation = suggestHeroPresentation(value.recipe)!;
  assert(!editorialContentSchema.safeParse({ ...value, recipe: { ...value.recipe, heroPresentation: { ...value.recipe.heroPresentation, container: 'tray' } } }).success);
  assert(!editorialContentSchema.safeParse({ ...value, recipe: { ...value.recipe, heroPresentation: { ...value.recipe.heroPresentation, profileVersion: 'unvalidated' } } }).success);
  value.recipe.heroPresentation.finalAppearance.en = 'x'.repeat(601);
  assert(!editorialContentSchema.safeParse(value).success);
});

test('a reviewed omission replaces only photo coverage and expires when its exact instruction changes', async () => {
  const { createStepPhotoOmission } = await import('../../lib/step-photo-selection');
  const value = content(); const step = value.recipe.steps[0];
  delete value.photos.steps[step.id];
  const photoIssue = () => publicationIssues(value).filter(issue => issue.field === `steps.${step.id}.photo`);
  assert.equal(photoIssue().length, 1);
  value.photos.omittedSteps = { [step.id]: createStepPhotoOmission(step, { pl: 'Przygotowanie pokazuje kolejne zdjęcie.', en: 'The next photograph illustrates the preparation.' }) };
  assert(editorialContentSchema.safeParse(value).success);
  assert.equal(photoIssue().length, 0);
  step.text.en += ' Check the cut size carefully.';
  assert.equal(photoIssue().length, 1);
});
