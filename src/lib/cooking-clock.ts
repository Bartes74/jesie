import type { Locale } from './recipes';
const wholeSeconds = (seconds: number) => Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;

/** Countdowns switch to hours at 60 minutes instead of showing 180:00. */
export function formatCookingClock(seconds: number): string {
  const total = wholeSeconds(seconds), hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60, rest = total % 60;
  return `${hours ? `${hours}:` : ''}${minutes.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`;
}

export function cookingClockLabel(seconds: number, locale: Locale): string {
  const total = wholeSeconds(seconds), hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60, rest = total % 60;
  const parts = [hours ? `${hours} ${locale === 'pl' ? 'godz.' : 'hr'}` : '', minutes ? `${minutes} min` : '', `${rest} ${locale === 'pl' ? 'sek.' : 'sec'}`].filter(Boolean);
  return `${locale === 'pl' ? 'Pozostały czas' : 'Time remaining'}: ${parts.join(' ')}`;
}
