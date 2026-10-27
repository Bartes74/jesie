import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitStepWaitMinimum, plannedStepRestMinutes } from './recipe-timing-evidence';

const step = (pl: string, en: string) => ({ title: { pl: 'Odstaw', en: 'Rest' }, text: { pl, en } });
test('clear mandatory day and hour waits supply conservative lower bounds in either language', () => {
  assert.equal(explicitStepWaitMinimum(step('Przed podaniem pozostaw ogórki w lodówce na 1–2 dni, aby nabrały smaku.', '')), 1440);
  assert.equal(explicitStepWaitMinimum(step('Chłodź przez minimum 24 godziny przed podaniem.', '')), 1440);
  assert.equal(explicitStepWaitMinimum(step('', 'Chill for at least 4 hours before serving.')), 240);
  assert.equal(explicitStepWaitMinimum(step('Odstaw na około 90 minut.', 'Rest for about 90 minutes.')), 90);
});
test('deadlines, negative cautions, cooking durations and shorter checkpoints do not invent a long rest', () => {
  assert.equal(explicitStepWaitMinimum(step('Wstaw do lodówki najpóźniej w ciągu 2 godzin.', 'Refrigerate within 2 hours.')), 0);
  assert.equal(explicitStepWaitMinimum(step('Nie pozostawiaj na blacie przez 24 godziny.', 'Do not rest for 24 hours.')), 0);
  assert.equal(explicitStepWaitMinimum(step('Odstaw na 20 minut, następnie piecz 90 minut.', 'Rest for 20 minutes, then bake for 90 minutes.')), 0);
  assert.equal(explicitStepWaitMinimum(step('Pozostaw w piekarniku na 2 godziny.', 'Leave in the oven for 2 hours.')), 0);
});
test('a long wait cannot be manufactured by adding concurrently scheduled rests', () => {
  assert.equal(plannedStepRestMinutes([{ stepId: 'chill', kind: 'rest', startMinute: 0, durationMinutes: 720 },
    { stepId: 'chill', kind: 'rest', startMinute: 0, durationMinutes: 720 }, { stepId: 'other', kind: 'rest', startMinute: 720, durationMinutes: 720 }], 'chill'), 720);
  assert.equal(plannedStepRestMinutes([{ stepId: 'chill', kind: 'rest', startMinute: 0, durationMinutes: 720 },
    { stepId: 'chill', kind: 'rest', startMinute: 720, durationMinutes: 720 }], 'chill'), 1440);
});
