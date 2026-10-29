import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutPageContentSchema, aboutSections, defaultAboutPage } from './about-page';

test('about body groups paragraphs under headings on blank lines', () => {
  assert.deepEqual(aboutSections('Wstęp bez nagłówka\r\n\r\n## Tytuł\n\nPierwsza linia\ndruga linia\n\n\n  \nDrugi akapit\n'), [
    { heading: null, paragraphs: ['Wstęp bez nagłówka'] },
    { heading: 'Tytuł', paragraphs: ['Pierwsza linia druga linia', 'Drugi akapit'] },
  ]);
});

test('built-in about content is valid and keeps both sections in each language', () => {
  assert.deepEqual(aboutPageContentSchema.parse(defaultAboutPage), defaultAboutPage);
  for (const locale of ['pl', 'en'] as const) assert.equal(aboutSections(defaultAboutPage[locale].body).filter(section => section.heading).length, 2);
  assert.throws(() => aboutPageContentSchema.parse({ ...defaultAboutPage, en: { ...defaultAboutPage.en, heading: ' ' } }));
});
