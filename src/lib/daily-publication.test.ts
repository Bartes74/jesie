import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyPublicationLocalTime,
  dailyPublicationTimezone,
  nextCalendarDate,
  nextPublicationDate,
  publicationTime,
  warsawPublicationDate,
} from './daily-publication';

test('publication policy specifies six o’clock in the Warsaw calendar', () => {
  assert.equal(dailyPublicationTimezone, 'Europe/Warsaw');
  assert.equal(dailyPublicationLocalTime, '06:00');
});

test('winter and summer publication instants both render as local 06:00', () => {
  const cases = [
    ['2026-01-15', '2026-01-15T05:00:00.000Z'],
    ['2026-07-15', '2026-07-15T04:00:00.000Z'],
  ];
  const localClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const [date, utc] of cases) {
    const instant = publicationTime(date);
    assert.equal(instant.toISOString(), utc);
    assert.equal(localClock.format(instant), '06:00');
    assert.equal(warsawPublicationDate(instant), date);
  }
});

test('spring daylight saving change keeps one publication date while the UTC interval is 23 hours', () => {
  const before = publicationTime('2026-03-28');
  const transition = publicationTime('2026-03-29');
  assert.equal(before.toISOString(), '2026-03-28T05:00:00.000Z');
  assert.equal(transition.toISOString(), '2026-03-29T04:00:00.000Z');
  assert.equal(transition.getTime() - before.getTime(), 23 * 60 * 60 * 1_000);
  assert.equal(nextCalendarDate('2026-03-28'), '2026-03-29');
  assert.equal(publicationTime('2026-03-30').toISOString(), '2026-03-30T04:00:00.000Z');
});

test('autumn daylight saving change keeps one publication date while the UTC interval is 25 hours', () => {
  const before = publicationTime('2026-10-24');
  const transition = publicationTime('2026-10-25');
  assert.equal(before.toISOString(), '2026-10-24T04:00:00.000Z');
  assert.equal(transition.toISOString(), '2026-10-25T05:00:00.000Z');
  assert.equal(transition.getTime() - before.getTime(), 25 * 60 * 60 * 1_000);
  assert.equal(nextCalendarDate('2026-10-24'), '2026-10-25');
  assert.equal(publicationTime('2026-10-26').toISOString(), '2026-10-26T05:00:00.000Z');
});

test('the publication day follows Warsaw midnight instead of UTC midnight', () => {
  assert.equal(warsawPublicationDate(new Date('2026-01-14T22:59:59.999Z')), '2026-01-14');
  assert.equal(warsawPublicationDate(new Date('2026-01-14T23:00:00.000Z')), '2026-01-15');
  assert.equal(warsawPublicationDate(new Date('2026-07-14T21:59:59.999Z')), '2026-07-14');
  assert.equal(warsawPublicationDate(new Date('2026-07-14T22:00:00.000Z')), '2026-07-15');
});

test('preparation targets today before the due instant and tomorrow at or after local six', () => {
  for (const date of ['2026-01-15', '2026-03-29', '2026-07-15', '2026-10-25']) {
    const due = publicationTime(date);
    const previousMillisecond = new Date(due.getTime() - 1);
    const unchanged = previousMillisecond.getTime();
    assert.equal(nextPublicationDate(previousMillisecond), date);
    assert.equal(previousMillisecond.getTime(), unchanged);
    assert.equal(nextPublicationDate(due), nextCalendarDate(date));
    assert.equal(nextPublicationDate(new Date(due.getTime() + 1)), nextCalendarDate(date));
  }
});

test('calendar increments handle leap day, month end and year end', () => {
  assert.equal(nextCalendarDate('2028-02-28'), '2028-02-29');
  assert.equal(nextCalendarDate('2028-02-29'), '2028-03-01');
  assert.equal(nextCalendarDate('2026-02-28'), '2026-03-01');
  assert.equal(nextCalendarDate('2026-12-31'), '2027-01-01');
});

test('invalid date strings and invalid clock values cannot form a publication slot', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-01T06:00:00Z', 'today']) {
    assert.throws(() => publicationTime(date), /INVALID_PUBLICATION_DATE/);
    assert.throws(() => nextCalendarDate(date), /INVALID_PUBLICATION_DATE/);
  }
  assert.throws(() => warsawPublicationDate(new Date(Number.NaN)), /INVALID_PUBLICATION_DATE/);
  assert.throws(() => nextPublicationDate(new Date(Number.NaN)), /INVALID_PUBLICATION_DATE/);
});
