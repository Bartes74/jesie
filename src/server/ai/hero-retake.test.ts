import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroRetakeVersionForBrief, isCompleteHeroComposition } from './hero-retake';

test('ordinary finished-dish retakes require the same cutout as the original hero', () => {
  for (const brief of ['Gotowa potrawa na talerzu', 'Podaj gotową potrawę w glinianym garnku.', 'The finished dish in the original bowl.', 'Gotowy sos w sosjerce.', 'Zdjęcie gotowej potrawy.', 'Gotowe danie.', 'Finished dish photo.', 'In the original bowl.', 'Pokaż gotową potrawę w kieliszku.', 'Gotowa potrawa w szklance.', 'The finished dish in a glass.', 'In a goblet.']) {
    assert.equal(heroRetakeVersionForBrief(brief), 'vessel-cutout-v1');
    assert.equal(isCompleteHeroComposition(true, brief), false);
  }
});

test('requested serving surfaces, detached props and unfamiliar scenes retain their complete composition', () => {
  for (const brief of ['Na deseczce z nożykiem.', 'Potrawa na desce.', 'Potrawa na deseczce.', 'Potrawa na talerzu z łyżką obok.', 'Danie na tacy.', 'On a serving slate with two spoons.', 'Food on a wooden board.', 'Gotowa potrawa na talerzu, obok kieliszek wina.', 'Gotowa potrawa na talerzu z kieliszkiem wina.', 'The finished dish in a bowl with a candle.', 'A plate of food with a candle beside it.', 'A bowl with flowers in the background.', 'An artistic composition.']) {
    assert.equal(heroRetakeVersionForBrief(brief), 'complete-composition-v1');
    assert.equal(isCompleteHeroComposition(true, brief), true);
  }
  assert.equal(isCompleteHeroComposition(false, 'Na deseczce z nożykiem.'), false);
  assert.equal(isCompleteHeroComposition(true, undefined), true, 'Unknown historical instructions cannot admit a vessel-only mask.');
});
