import type { Locale } from './recipes';
import { formatRecipeDuration } from './recipe-duration';

const amount = String.raw`\d+(?:[.,]\d+)?`;
const minuteUnit = String.raw`(?:minutes?|mins?|minut(?:ach|ami|om|y|ę|a)?|min)`;
const minuteRange = new RegExp(String.raw`(?<![\p{L}\p{N}.,:])(${amount})\s*([–−-]|to|do|and|a)\s*(${amount})\s*${minuteUnit}(?!\p{L})`, 'giu');
const minuteValue = new RegExp(String.raw`(?<![\p{L}\p{N}.,:])(${amount})\s*${minuteUnit}(?!\p{L})`, 'giu');
const numeric = (text: string) => Number(text.replace(',', '.'));
const beforePunctuation = (label: string, following: string) => label.endsWith('.') && following === '.' ? label.slice(0, -1) : label;

/** Display duration units without changing saved instructions, ranges or thresholds. */
export function formatRecipeDurationText(text: string, locale: Locale): string {
  const ranges = text.replace(minuteRange, (match, from: string, separator: string, to: string, offset: number, source: string) => {
    const first = numeric(from), last = numeric(to);
    if (first < 60 && last < 60) return match;
    if (['to', 'do', 'and', 'a'].includes(separator.toLowerCase())) return beforePunctuation(`${formatRecipeDuration(first, locale)} ${separator} ${formatRecipeDuration(last, locale)}`, source[offset + match.length]);
    if (first % 60 === 0 && last % 60 === 0) return beforePunctuation(`${first / 60}–${last / 60} ${locale === 'pl' ? 'godz.' : 'hr'}`, source[offset + match.length]);
    return beforePunctuation(`${formatRecipeDuration(first, locale)}–${formatRecipeDuration(last, locale)}`, source[offset + match.length]);
  });
  return ranges.replace(minuteValue, (match, value: string, offset: number, source: string) => numeric(value) < 60 ? match : beforePunctuation(formatRecipeDuration(numeric(value), locale), source[offset + match.length]));
}
