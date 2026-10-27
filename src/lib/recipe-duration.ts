import type { Locale } from './recipes';

/** Human-readable recipe time; persisted durations and timer values stay in minutes. */
export function formatRecipeDuration(minutes: number, locale: Locale = 'pl'): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';

  // Recipe times normally use whole minutes. Keep sub-minute precision without
  // exposing floating-point residue when splitting fractional values into hours.
  const roundedMinutes = Number(minutes.toFixed(3));
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = Number((roundedMinutes - hours * 60).toFixed(3));
  const number = new Intl.NumberFormat(locale === 'pl' ? 'pl-PL' : 'en-GB', {
    useGrouping: false,
    maximumFractionDigits: 3,
  });
  if (hours === 0) return `${number.format(remainder)} min`;
  const hourLabel = `${number.format(hours)} ${locale === 'pl' ? 'godz.' : 'hr'}`;
  return remainder > 0 ? `${hourLabel} ${number.format(remainder)} min` : hourLabel;
}
