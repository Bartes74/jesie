/** Publication uses the Warsaw calendar, including both daylight saving changes. */
export const dailyPublicationTimezone = 'Europe/Warsaw';
export const dailyPublicationLocalTime = '06:00';

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: dailyPublicationTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: dailyPublicationTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('INVALID_PUBLICATION_DATE');
  const value = new Date(`${date}T06:00:00.000Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new Error('INVALID_PUBLICATION_DATE');
  return value;
}

export function warsawPublicationDate(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_PUBLICATION_DATE');
  const parts = Object.fromEntries(calendar.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function nextCalendarDate(date: string): string {
  return new Date(validDate(date).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Six o'clock is outside Warsaw's repeated/missing hour on DST transition days. */
export function publicationTime(date: string): Date {
  const reference = validDate(date);
  const parts = Object.fromEntries(clock.formatToParts(reference).map(part => [part.type, part.value]));
  const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(reference.getTime() - (localAsUtc - reference.getTime()));
}

export function nextPublicationDate(now = new Date()): string {
  const date = warsawPublicationDate(now);
  return now.getTime() < publicationTime(date).getTime() ? date : nextCalendarDate(date);
}
