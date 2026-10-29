import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCollectionPalette, newCollectionContent, type CollectionTheme } from '../../lib/collections';
import { collectionActionInput, collectionContentSchema, collectionDefinitionSchema, collectionPublicationIssues, collectionThemeSchema, saveCollectionInput } from './validation';

const id = '4ec4e03e-f351-45a7-82c2-b73ba472d7a2';
const theme: CollectionTheme = { version: 1, palette: { ...defaultCollectionPalette }, hero: { assetId: id, src: `/media/collections/${id}`, width: 2048, height: 1536, alt: { pl: 'Ilustracja', en: 'Illustration' } }, atmosphere: null, decorationOpacity: .12 };
test('drafts may be incomplete, while publication requires both languages and an accepted generated theme', () => {
  const content = newCollectionContent('Boże Narodzenie');
  assert.equal(collectionContentSchema.safeParse(content).success, true);
  const issues = collectionPublicationIssues('christmas', content);
  assert.ok(issues.some(issue => issue.field === 'title.en'));
  assert.ok(issues.some(issue => issue.field === 'description.pl'));
  assert.ok(issues.some(issue => issue.field === 'theme'));
  const complete = { ...content, title: { pl: 'Święta', en: 'Christmas' }, description: { pl: 'Opis', en: 'Description' }, slug: { pl: 'swieta', en: 'christmas' }, theme, themeGenerationId: id };
  assert.deepEqual(collectionPublicationIssues('christmas', complete), []);
});
test('legacy collections can preserve their neutral appearance; promoting them requires reviewed artwork', () => {
  const content = { ...newCollectionContent(), title: { pl: 'Szybkie obiady', en: 'Quick dinners' }, description: { pl: 'Opis', en: 'Description' }, slug: { pl: 'szybkie-obiady', en: 'quick-dinners' }, minimumRecipes: 5 };
  assert.deepEqual(collectionPublicationIssues('quick-dinners', content), []);
  assert.ok(collectionPublicationIssues('quick-dinners', { ...content, promotion: { from: '2026-12-01', to: '2026-12-26' } }).some(issue => issue.field === 'theme'));
});
test('rejects duplicate recipe references, invalid periods, injected fields and malformed paths', () => {
  const content = newCollectionContent('Test');
  assert.equal(collectionContentSchema.safeParse({ ...content, recipeIds: ['a', 'a'] }).success, false);
  assert.equal(collectionContentSchema.safeParse({ ...content, promotion: { from: '2026-02-30', to: '2026-03-01' } }).success, false);
  assert.equal(collectionContentSchema.safeParse({ ...content, promotion: { from: '2026-12-26', to: '2026-12-01' } }).success, false);
  assert.equal(collectionContentSchema.safeParse({ ...content, html: '<script />' }).success, false);
  assert.equal(collectionContentSchema.safeParse({ ...content, slug: { pl: '../admin', en: 'christmas' } }).success, false);
});
test('generated themes use only registered collection asset paths and strict color tokens', () => {
  assert.equal(collectionThemeSchema.safeParse(theme).success, true);
  assert.equal(collectionThemeSchema.safeParse({ ...theme, hero: { ...theme.hero, src: 'https://example.invalid/private.webp' } }).success, false);
  assert.equal(collectionThemeSchema.safeParse({ ...theme, palette: { ...theme.palette, accent: 'url(javascript:alert(1))' } }).success, false);
  assert.equal(collectionThemeSchema.safeParse({ ...theme, css: 'body{display:none}' }).success, false);
});
test('admin mutations require a positive captured revision and do not accept publication fields in content', () => {
  assert.equal(saveCollectionInput.safeParse({ expectedRevision: 0, content: newCollectionContent() }).success, false);
  assert.equal(saveCollectionInput.safeParse({ expectedRevision: 1, content: { ...newCollectionContent(), publicationStatus: 'published' } }).success, false);
  assert.equal(collectionActionInput.safeParse({ expectedRevision: 1, action: 'publish' }).success, true);
  assert.equal(collectionActionInput.safeParse({ expectedRevision: 1, action: 'delete' }).success, false);
});
test('public snapshot validation refuses private appearance inputs', () => {
  const { appearanceBrief, inspirationAssetId, themeGenerationId, ...content } = newCollectionContent();
  void appearanceBrief; void inspirationAssetId; void themeGenerationId;
  assert.equal(collectionDefinitionSchema.safeParse({ id: 'christmas', ...content }).success, true);
  assert.equal(collectionDefinitionSchema.safeParse({ id: 'christmas', ...content, appearanceBrief: 'Private' }).success, false);
});

test('themes accept optional decorative accents in known slots only', () => {
  const accent = { ...theme.hero, alt: { pl: '', en: '' } };
  assert.equal(collectionThemeSchema.safeParse({ ...theme, accents: { corner: accent, garland: null, spot: accent } }).success, true);
  assert.equal(collectionThemeSchema.safeParse({ ...theme, accents: { corner: accent, garland: null } }).success, false);
  assert.equal(collectionThemeSchema.safeParse({ ...theme, accents: { corner: null, garland: null, spot: null, banner: accent } }).success, false);
});
