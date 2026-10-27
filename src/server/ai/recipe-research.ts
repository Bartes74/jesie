import type { Response } from 'openai/resources/responses/responses';
import type { SourceReference } from '@/lib/editorial-types';
import { ProviderError } from './provider-error';
import { recipeResearchSourcesSchema } from './recipe-proposal';

function publicSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname) || url.hostname.endsWith('.local')) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Bibliography is accepted only when the provider's actual search receipt contains its URL. */
export function recipeResearchSources(output: Response['output'], proposed: unknown, existing: SourceReference[]): SourceReference[] {
  const completed = output.filter(item => item.type === 'web_search_call' && item.status === 'completed');
  if (!completed.length) throw new ProviderError('AI_RESEARCH_REQUIRED', 'Nie potwierdzono researchu. Wynik nie zastąpił przepisu.', false, undefined,
    { issues: [{ field: 'researchSources', message: 'Brakuje zakończonego odczytu web_search potwierdzającego research.' }] });
  const consulted = new Map<string, string>();
  for (const item of completed) {
    if (item.type !== 'web_search_call') continue;
    const action = item.action;
    if (action.type === 'search') for (const source of action.sources ?? []) {
      const url = publicSourceUrl(source.url); if (url) consulted.set(url, source.url);
    }
    if (action.type === 'open_page' && action.url) {
      const url = publicSourceUrl(action.url); if (url) consulted.set(url, action.url);
    }
  }
  // Citations are also provider receipts; the structured result itself grants no trust.
  for (const item of output) if (item.type === 'message') for (const part of item.content) if (part.type === 'output_text') {
    for (const annotation of part.annotations) if (annotation.type === 'url_citation') {
      const url = publicSourceUrl(annotation.url); if (url) consulted.set(url, annotation.url);
    }
  }
  const parsed = recipeResearchSourcesSchema.safeParse(proposed);
  if (!parsed.success) throw new ProviderError('AI_RESEARCH_SOURCE_INVALID', 'Bibliografia wymaga poprawy.', false, undefined,
    { issues: parsed.error.issues.map(issue => ({ field: ['researchSources', ...issue.path].join('.'), message: issue.message })), repairable: true });
  const sources = parsed.data;
  const verified = sources.map(source => ({ ...source, url: publicSourceUrl(source.url) }));
  const issues = verified.flatMap((source, index) => !source.url || !consulted.has(source.url)
    ? [{ field: `researchSources.${index}.url`, message: 'Zastąp ten adres dokładnym publicznym HTTPS URL z zakończonych wyników web_search lub cytowań tej odpowiedzi. Nie twórz nowego adresu.' }] : []);
  if (issues.length) throw new ProviderError('AI_RESEARCH_SOURCE_INVALID', 'Research wskazał niepotwierdzone źródło. Wynik nie zastąpił przepisu.', false, undefined,
    { issues, repairable: true });
  const result = [...existing];
  const urls = new Set(existing.map(source => publicSourceUrl(source.url)).filter(Boolean));
  for (const source of verified) if (!urls.has(source.url!)) {
    let suffix = result.length + 1;
    while (result.some(item => item.id === `research-${suffix}`)) suffix++;
    result.push({ id: `research-${suffix}`, title: source.title, url: source.url! });
    urls.add(source.url!);
  }
  return result.slice(0, 100);
}
