/** Aggregate event names are deliberately fixed: no arbitrary labels or personal data. */
export const usageEventNames = ['page_view', 'servings_change', 'recipe_save', 'cooking_step', 'cooking_step_undo', 'ingredient_check', 'ingredient_uncheck', 'print_recipe', 'cooking_start', 'cooking_complete', 'repeat_cook', 'shopping_copy', 'plan_add', 'plan_remove', 'pantry_use', 'search', 'no_results', 'feedback_submit'] as const;
export type UsageEventName = typeof usageEventNames[number];
export const usageLabels: Record<UsageEventName, string> = { page_view: 'wyświetleń stron', servings_change: 'zmian porcji', recipe_save: 'zapisów przepisu', cooking_step: 'ukończeń kroku', cooking_step_undo: 'cofnięć kroku', ingredient_check: 'zaznaczeń składnika', ingredient_uncheck: 'odznaczeń składnika', print_recipe: 'prób wydruku', cooking_start: 'rozpoczęć gotowania', cooking_complete: 'deklaracji „Ugotowane”', repeat_cook: 'ponownych gotowań na urządzeniu', shopping_copy: 'skopiowanych list zakupów', plan_add: 'dodań do planu', plan_remove: 'usunięć z planu', pantry_use: 'użyć lodówki', search: 'wyszukiwań', no_results: 'wyszukiwań bez wyników', feedback_submit: 'wysłanych opinii' };
export const usageSources = ['direct', 'google', 'bing', 'pinterest', 'chatgpt', 'perplexity', 'claude', 'other'] as const;
export type UsageSource = typeof usageSources[number];
export type UsageEvent = { name: UsageEventName; path: string; source: UsageSource };
export const usageBodyLimit = 1024;
export const usageTimeZone = 'Europe/Warsaw';

/** Keep only public canonical-shaped paths, never query strings or fragments. */
export function usagePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500 || /[\u0000-\u0020\u007f\\%]/.test(value)) return null;
  const path = value.split(/[?#]/, 1)[0].replace(/\/$/, '');
  return /^\/(?:pl|en)(?:\/(?:o-serwisie|plan)|\/(?:kolekcje|poradniki)|\/(?:recipes|kolekcje|poradniki)\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(path) ? path : null;
}

export function parseUsageEvent(value: unknown): UsageEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || !Object.keys(input).every(key => ['name', 'path', 'source'].includes(key))) return null;
  if (!usageEventNames.some(name => name === input.name) || !usageSources.some(source => source === input.source)) return null;
  const path = usagePath(input.path);
  const catalogAction = ['pantry_use', 'search', 'no_results', 'shopping_copy', 'plan_remove'].includes(String(input.name));
  if (!path || (input.name !== 'page_view' && !/^\/(?:pl|en)\/recipes\//.test(path) && !(catalogAction && /^\/(?:pl|en)(?:\/plan|\/kolekcje\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(path)))) return null;
  return { name: input.name as UsageEventName, path, source: input.source as UsageSource };
}

/** Classification uses only the hostname; a raw referrer is never sent or stored. */
export function usageSource(referrer: string, siteOrigin: string): UsageSource {
  if (!referrer) return 'direct';
  let url: URL;
  try { url = new URL(referrer); } catch { return 'other'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'other';
  try { if (url.origin === new URL(siteOrigin).origin) return 'direct'; } catch { return 'other'; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const domain = (name: string) => hostname === name || hostname.endsWith(`.${name}`);
  if (/^(?:[a-z0-9-]+\.)*google\.(?:com|pl|co\.uk|de|fr|es|it|nl|ca|com\.au|co\.jp|co\.in)$/.test(hostname)) return 'google';
  if (domain('bing.com')) return 'bing';
  if (/^(?:[a-z0-9-]+\.)*pinterest\.(?:com|pl|co\.uk|de|fr|es|it|ca|com\.au)$/.test(hostname)) return 'pinterest';
  if (domain('chatgpt.com') || domain('chat.openai.com')) return 'chatgpt';
  if (domain('perplexity.ai')) return 'perplexity';
  if (domain('claude.ai')) return 'claude';
  return 'other';
}

export function isUsageBot(userAgent: string | null): boolean {
  return !userAgent || /bot\b|crawler|spider|slurp|headless|lighthouse|curl|wget|python|httpclient|facebookexternalhit|chatgpt-user|claude-user|perplexity-user/i.test(userAgent);
}

const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: usageTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
export function usageDay(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_USAGE_DATE');
  const parts = Object.fromEntries(calendar.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function usagePeriod(days = 30, now = new Date()) {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(365, Math.floor(days))) : 30;
  const to = usageDay(now);
  const from = new Date(Date.parse(`${to}T12:00:00Z`) - (safeDays - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to, days: safeDays, timeZone: usageTimeZone };
}
