import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCollectionPalette, collectionThemeIssues } from '@/lib/collections';
import { collectionThemeSchema } from './validation';
import { accessibleThemeProposal, themeContrast, themeProposalSchema, type ThemeProposal } from './theme-policy';

const proposal = (palette: Partial<ThemeProposal['palette']> = {}): ThemeProposal => ({
  palette: { ...defaultCollectionPalette, ...palette }, decorationOpacity: .08,
  heroPrompt: 'An original editorial illustration of a warm festive evening.',
  atmospherePrompt: 'Quiet seasonal ornaments at the edges with a clear centre.',
  heroAlt: { pl: 'Świąteczna ilustracja', en: 'A festive illustration' },
  atmosphereAlt: { pl: 'Dekoracyjne tło', en: 'Decorative background' },
});
const bodySurfaces = ['background', 'surface', 'heroBackground', 'catalogBackground', 'photoBackground', 'panelBackground'] as const;
function checkUsable(input: unknown) {
  const result = accessibleThemeProposal(input);
  for (const field of ['text', 'muted', 'heading'] as const) for (const surface of bodySurfaces) assert.ok(themeContrast(result.palette[field], result.palette[surface]) >= 4.5, `${field} on ${surface}`);
  assert.ok(themeContrast(result.palette.accentText, result.palette.accent) >= 4.5);
  const theme = { version: 1 as const, palette: result.palette, decorationOpacity: result.decorationOpacity, atmosphere: null,
    hero: { assetId: '68c786ec-50fa-4dd7-8b22-e936376462b9', src: '/media/collections/68c786ec-50fa-4dd7-8b22-e936376462b9', width: 1536, height: 1536, alt: result.heroAlt } };
  assert.deepEqual(collectionThemeIssues(theme), []);
  assert.equal(collectionThemeSchema.safeParse(theme).success, true);
  assert.deepEqual(accessibleThemeProposal(result), result, 'normalization is stable when a saved theme is read again');
  return result;
}

test('readable existing brand colours survive normalization without losing the generated prompts', () => {
  const input = proposal();
  const result = checkUsable(input);
  assert.deepEqual(result.palette, input.palette);
  assert.equal(result.heroPrompt, input.heroPrompt);
  assert.equal(result.decorationOpacity, .08);
  assert.deepEqual(input, proposal(), 'normalization does not mutate the generated proposal');
});

test('muted text and headings remain readable on hero, catalogue and shopping panels', () => {
  const result = checkUsable(proposal({ heroBackground: '#919191', panelBackground: '#999999', catalogBackground: '#aaaaaa', text: '#777777', muted: '#909090', heading: '#bbbbbb' }));
  assert.notEqual(result.palette.muted, '#909090');
  assert.notEqual(result.palette.heading, '#bbbbbb');
  assert.equal(result.palette.heroBackground, '#919191', 'readable light-family art direction is preserved');
});

test('a dark visual direction receives readable light text across every body surface', () => {
  const result = checkUsable(proposal({ surface: '#141b17', background: '#19211c', heroBackground: '#303830', catalogBackground: '#242a25', panelBackground: '#333a35', photoBackground: '#121a14' }));
  assert.equal(result.palette.background, '#19211c');
  assert.notEqual(result.palette.text, defaultCollectionPalette.text);
});

test('middle-grey accents can use a readable neutral when brand foregrounds cannot meet AA', () => {
  const result = checkUsable(proposal({ accent: '#777777', accentText: '#888888' }));
  assert.equal(result.palette.accent, '#777777');
  assert.ok(themeContrast(result.palette.accentText, '#777777') >= 4.5);
});

test('all supported grey luminances normalize to a publishable theme, including mixed light and dark suggestions', () => {
  const grey = (value: number) => `#${value.toString(16).padStart(2, '0').repeat(3)}`;
  for (let i = 0; i <= 255; i += 13) checkUsable(proposal({ surface: grey(i), background: grey(255 - i), heroBackground: grey((i + 47) % 256), catalogBackground: grey((i + 93) % 256), panelBackground: grey((i + 167) % 256), photoBackground: grey((i + 229) % 256), text: grey(i), muted: grey(255 - i), heading: grey((i + 64) % 256), accent: grey(i), accentText: grey(i) }));
});

test('theme proposals accept data only and reject executable styling and unsafe colour values', () => {
  assert.equal(themeProposalSchema.safeParse({ ...proposal(), css: 'body { display:none }' }).success, false);
  assert.equal(themeProposalSchema.safeParse({ ...proposal(), palette: { ...defaultCollectionPalette, background: 'url(https://example.test/tracker)' } }).success, false);
  assert.equal(themeProposalSchema.safeParse({ ...proposal(), decorationOpacity: .5 }).success, false);
});
