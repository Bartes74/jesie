import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRecipeDurationText as format } from './recipe-duration-text';

test('long-minute prose preserves cooking endpoints and food-safety deadlines in both languages', () => {
  assert.equal(format('Duś 180–240 minut. Po 180 minutach sprawdź. Kontroluj co 20–30 minut.', 'pl'), 'Duś 3–4 godz. Po 3 godz. sprawdź. Kontroluj co 20–30 minut.');
  assert.equal(format('Braise for 180–240 minutes. Check after 180 minutes, then every 20–30 minutes.', 'en'), 'Braise for 3–4 hr. Check after 3 hr, then every 20–30 minutes.');
  assert.equal(format('Studź 60 minut. Wstaw do lodówki przed upływem 120 minut, następnie chłodź co najmniej 240 minut.', 'pl'), 'Studź 1 godz. Wstaw do lodówki przed upływem 2 godz., następnie chłodź co najmniej 4 godz.');
  assert.equal(format('Refrigerate within 90 minutes. Chill for at least 24 hours.', 'en'), 'Refrigerate within 1 hr 30 min. Chill for at least 24 hours.');
});

test('ranges crossing the hour boundary retain both endpoints and decimal minutes are exact', () => {
  assert.equal(format('Około 55–65 minut i 90–120 minut.', 'pl'), 'Około 55 min–1 godz. 5 min i 1 godz. 30 min–2 godz.');
  assert.equal(format('Wait 60.5 minutes or 90 mins.', 'en'), 'Wait 1 hr 0.5 min or 1 hr 30 min.');
  assert.equal(format('Przez 60,5 minuty.', 'pl'), 'Przez 1 godz. 0,5 min.');
});

test('display conversion is idempotent and does not touch ingredient quantities, temperatures, days or short waits', () => {
  const original = '180 g mięsa, 240 ml bulionu, 180°C. Piecz 20–30 minut, przechowuj przez 2 dni. Odczekaj 90 minut.';
  const converted = format(original, 'pl');
  assert.equal(converted, '180 g mięsa, 240 ml bulionu, 180°C. Piecz 20–30 minut, przechowuj przez 2 dni. Odczekaj 1 godz. 30 min.');
  assert.equal(format(converted, 'pl'), converted);
  assert.equal(format('Cook for 1 hr 30 min; 90 ml water is the minimum.', 'en'), 'Cook for 1 hr 30 min; 90 ml water is the minimum.');
});


test('worded ranges retain their connective instead of leaving a unitless endpoint', () => {
  assert.equal(format('Cook between 180 and 240 minutes.', 'en'), 'Cook between 3 hr and 4 hr.');
  assert.equal(format('Gotuj od 60 do 90 minut.', 'pl'), 'Gotuj od 1 godz. do 1 godz. 30 min.');
  assert.equal(format('Bake 90 to 120 minutes.', 'en'), 'Bake 1 hr 30 min to 2 hr.');
});
