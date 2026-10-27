import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicRecipe } from './recipe-presentation';
import { collectionContrast, collectionDate, collectionIsDiscoverable, collectionPromotionActive, collectionPromotionsOverlap,
  collectionPublicDefinition, collectionSlug, collectionThemeIssues, defaultCollectionPalette, isCollectionDate,
  newCollectionContent, nextCollectionMidnight, resolveCollection, selectPromotedCollection, validCollectionPromotion,
  type CollectionDefinition, type CollectionTheme } from './collections';

const assetId = '4ec4e03e-f351-45a7-82c2-b73ba472d7a2';
const theme: CollectionTheme = { version: 1, palette: { ...defaultCollectionPalette },
  hero: { assetId, src: `/media/collections/${assetId}`, width: 2048, height: 1536, alt: { pl: 'Świąteczna ilustracja', en: 'Christmas illustration' } }, atmosphere: null, decorationOpacity: .12 };
function recipe(id: string, total = 20, primaryCategory = 'main') { return { id, times: { total }, primaryCategory } as PublicRecipe; }
function definition(values: Partial<CollectionDefinition> = {}): CollectionDefinition {
  return { ...collectionPublicDefinition('christmas', newCollectionContent('Boże Narodzenie')), theme, recipeIds: ['a'], promotion: { from: '2026-12-01', to: '2026-12-26' }, ...values };
}

test('promotions cover both full Warsaw calendar dates, independently of the visitor time zone', () => {
  const promotion = { from: '2026-12-01', to: '2026-12-02' };
  assert.equal(collectionPromotionActive(promotion, new Date('2026-11-30T22:59:59.999Z')), false);
  assert.equal(collectionPromotionActive(promotion, new Date('2026-11-30T23:00:00.000Z')), true);
  assert.equal(collectionPromotionActive(promotion, new Date('2026-12-02T22:59:59.999Z')), true);
  assert.equal(collectionPromotionActive(promotion, new Date('2026-12-02T23:00:00.000Z')), false);
  assert.equal(collectionPromotionActive(null), false);
});
test('Warsaw midnight calculation handles the 23-hour and 25-hour daylight-saving days', () => {
  assert.equal(nextCollectionMidnight(new Date('2026-03-28T23:00:00Z')).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(nextCollectionMidnight(new Date('2026-10-24T22:00:00Z')).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal(collectionDate(new Date('2026-10-25T22:59:59Z')), '2026-10-25');
  assert.equal(collectionDate(new Date('2026-10-25T23:00:00Z')), '2026-10-26');
  assert.throws(() => collectionDate(new Date(NaN)), /INVALID_COLLECTION_DATE/);
});
test('validates actual dates, same-day events and inclusive overlaps across years', () => {
  assert.equal(isCollectionDate('2026-02-30'), false);
  assert.equal(isCollectionDate('2028-02-29'), true);
  assert.equal(isCollectionDate('2026-2-1'), false);
  assert.equal(validCollectionPromotion({ from: '2026-10-31', to: '2026-10-31' }), true);
  assert.equal(validCollectionPromotion({ from: '2026-11-01', to: '2026-10-31' }), false);
  assert.equal(collectionPromotionsOverlap({ from: '2026-12-24', to: '2027-01-01' }, { from: '2027-01-01', to: '2027-01-02' }), true);
  assert.equal(collectionPromotionsOverlap({ from: '2026-12-24', to: '2027-01-01' }, { from: '2027-01-02', to: '2027-01-03' }), false);
  assert.equal(collectionPromotionsOverlap(null, { from: '2026-12-24', to: '2027-01-01' }), false);
});
test('manual selection follows administrator order and ignores withdrawn recipe identities', () => {
  const selected = resolveCollection(definition({ recipeIds: ['b', 'withdrawn', 'a', 'b'] }), [recipe('a'), recipe('b'), recipe('outside')], 'en');
  assert.deepEqual(selected.recipes.map(item => item.id), ['b', 'a']);
  assert.equal(selected.path, '/en/kolekcje/');
  assert.equal(collectionIsDiscoverable(selected), true);
});
test('only quick dinners selects automatically; the other legacy collections retain manual members and minimum five', () => {
  const recipes = [recipe('main'), recipe('soup', 30, 'soup'), recipe('breakfast', 10, 'breakfast'), recipe('slow', 31), recipe('unknown', 0)];
  assert.deepEqual(resolveCollection(definition({ id: 'quick-dinners', selectionMode: 'quick-dinners', recipeIds: [] }), recipes, 'pl').recipes.map(item => item.id), ['main', 'soup']);
  for (const id of ['pantry', 'seasonal', 'one-pot']) {
    const collection = resolveCollection(definition({ id, selectionMode: 'manual', recipeIds: ['slow'], minimumRecipes: 5 }), recipes, 'pl');
    assert.deepEqual(collection.recipes.map(item => item.id), ['slow']);
    assert.equal(collectionIsDiscoverable(collection), false);
  }
});
test('empty and out-of-season collections retain a resolvable page but do not occupy the promoted hero', () => {
  const empty = resolveCollection(definition({ recipeIds: ['withdrawn'] }), [recipe('a')], 'pl');
  const complete = resolveCollection(definition(), [recipe('a')], 'pl');
  assert.equal(empty.id, 'christmas');
  assert.equal(selectPromotedCollection([empty], new Date('2026-12-10T12:00:00Z')), null);
  assert.equal(selectPromotedCollection([complete], new Date('2026-12-10T12:00:00Z'))?.id, 'christmas');
  assert.equal(selectPromotedCollection([complete], new Date('2026-12-27T12:00:00Z')), null);
  assert.equal(selectPromotedCollection([{ ...complete, theme: null }], new Date('2026-12-10T12:00:00Z')), null);
});
test('public snapshot omits private prompts, inspiration and generation receipts', () => {
  const content = { ...newCollectionContent('Święta'), appearanceBrief: 'Private instructions', inspirationAssetId: assetId, themeGenerationId: assetId };
  const published = collectionPublicDefinition('christmas', content, '2026-10-27T12:00:00Z');
  assert.equal('appearanceBrief' in published, false);
  assert.equal('inspirationAssetId' in published, false);
  assert.equal('themeGenerationId' in published, false);
  assert.equal(published.dateModified, '2026-10-27T12:00:00Z');
  assert.equal(collectionSlug('Łódzkie święta — Wielkanoc!'), 'lodzkie-swieta-wielkanoc');
});
test('theme validation rejects unreadable generated palettes and excessive decoration opacity', () => {
  assert.deepEqual(collectionThemeIssues(theme), []);
  assert.ok(collectionContrast('#203f32', '#faf8f2') > 4.5);
  assert.equal(collectionContrast('url(https://example.invalid)', '#ffffff'), 0);
  assert.ok(collectionThemeIssues({ ...theme, palette: { ...theme.palette, text: '#faf8f2' } }).some(issue => issue.field === 'theme.palette.text'));
  assert.ok(collectionThemeIssues({ ...theme, decorationOpacity: .5 }).some(issue => issue.field === 'theme.decorationOpacity'));
});
