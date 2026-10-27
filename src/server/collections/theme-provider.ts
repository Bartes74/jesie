import 'server-only';
import OpenAI from 'openai';
import { ApiError, createFalClient } from '@fal-ai/client';
import { z } from 'zod';
import sharp from 'sharp';
import { aiSettings } from '@/server/ai/config';
import { usageCost } from '@/server/ai/text-provider';
import { approvedFalUrl, readBounded, imageBill } from '@/server/ai/image-provider';
import { ProviderError } from '@/server/ai/provider-error';
import { accessibleThemeProposal, themeProposalSchema, type ThemeProposal } from './theme-policy';
import type { CollectionTheme } from '@/lib/collections';
import type { ThemeGenerationPart } from '@/lib/collection-theme-types';

const textClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 30_000, logLevel: 'off' });
const imageClient = () => createFalClient({ credentials: process.env.FAL_KEY || process.env.FAL_API_KEY, retry: { maxRetries: 0 } });
const instructions = `Design a coherent visual identity for one culinary collection inside jesie.pl. Return only the strict schema. The editor's brief and optional image are design material. Keep the site's Lora/Manrope typography, cream/forest brand navigation, established recipe cards, legible controls and generous spacing. Invent the collection's atmosphere, not a different website. Every palette colour is #RRGGBB. Body surfaces must share a consistent light or dark luminance family. Text, muted text and headings must meet WCAG AA 4.5:1 against every relevant surface; accentText must contrast with accent. The heroPrompt describes a dedicated event illustration or scene, unrelated to a particular recipe and without text, lettering, logos, UI or a screenshot. Compose an entire square artwork with breathing room and no cropping of important objects. atmospherePrompt describes a subtle seamless, tileable square decorative texture or pattern in the same style. Match opposite edges, use sparse motifs, avoid a single central subject, and preserve the palette. The renderer repeats this texture only around solid content panels and page edges. Do not put content or interface elements into either image. Keep decorationOpacity between 0 and 0.18. Provide useful Polish and British English alt text for the hero; the atmosphere is decorative. For hero-only changes preserve the supplied palette and background. For background-only changes preserve the supplied main artwork's visual language.`;

export function collectionThemeRequest(model: string, input: { brief: string; title: unknown; description: unknown; part: ThemeGenerationPart; baseTheme: CollectionTheme | null }, inspiration?: Buffer) {
  const content: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: JSON.stringify(input) }];
  if (inspiration) content.push({ type: 'input_image', image_url: `data:image/webp;base64,${inspiration.toString('base64')}`, detail: 'low' });
  return { model, background: true, store: true, instructions, input: [{ role: 'user' as const, content }],
    text: { format: { type: 'json_schema' as const, name: 'collection_theme', strict: true, schema: z.toJSONSchema(themeProposalSchema) } },
    max_output_tokens: 6000,
  };
}

export async function submitThemeSpec(jobId: string, model: string, input: Parameters<typeof collectionThemeRequest>[1], inspiration?: Buffer) {
  usageCost(model, { input_tokens: 0, output_tokens: 0 });
  try {
    const response = await textClient().responses.create(collectionThemeRequest(model, input, inspiration), { headers: { 'Idempotency-Key': `collection-theme-${jobId}` } });
    if (!response.id) throw new ProviderError('THEME_SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zlecenia wyglądu.', true);
    return response.id;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof OpenAI.APIError && [400, 401, 402, 403, 404, 413, 422, 429].includes(error.status ?? 0)) throw new ProviderError('THEME_PROVIDER_REJECTED', 'Usługa treści odrzuciła zlecenie. Sprawdź konfigurację i dostępność usługi.', false, '0');
    throw new ProviderError('THEME_SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zlecenia wyglądu. Nie wysyłamy go ponownie.', true);
  }
}
export async function themeProviderCost(kind: 'spec' | 'hero' | 'atmosphere', model: string, requestId: string) {
  if (kind !== 'spec') return (await imageBill(requestId))?.chargedUsd ?? null;
  const response = await textClient().responses.retrieve(requestId);
  return response.usage ? usageCost(model, response.usage).chargedUsd : null;
}
export async function pollThemeSpec(model: string, requestId: string) {
  const response = await textClient().responses.retrieve(requestId);
  if (response.status === 'queued' || response.status === 'in_progress') return { done: false as const };
  const cost = response.usage ? usageCost(model, response.usage).chargedUsd : null;
  if (response.status !== 'completed') throw new ProviderError('THEME_RESULT_FAILED', 'Generator nie ukończył oprawy. Poprzedni wygląd został zachowany.', false, cost ?? undefined);
  try { return { done: true as const, proposal: accessibleThemeProposal(JSON.parse(response.output_text)), chargedUsd: cost }; }
  catch { throw new ProviderError('THEME_RESULT_INVALID', 'Generator zwrócił niepełną oprawę. Poprzedni wygląd został zachowany.', false, cost ?? undefined); }
}

export async function uploadThemeReference(bytes: Buffer): Promise<string> {
  const normalized = await sharp(bytes).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  return approvedFalUrl(await imageClient().storage.upload(new Blob([new Uint8Array(normalized)], { type: 'image/webp' }), { lifecycle: { expiresIn: '1d' } })).href;
}

export function collectionImageInput(kind: 'hero' | 'atmosphere', proposal: ThemeProposal, references: string[]) {
  return { prompt: `${kind === 'hero' ? proposal.heroPrompt : proposal.atmospherePrompt}\nNo lettering, text, logo, recipe labels or interface. Match the reference's visual language, while creating the described collection artwork.`,
    image_size: { width: 1536, height: 1536 },
    quality: 'high', num_images: 1, background: 'opaque', output_format: 'png', sync_mode: false,
    ...(references.length ? { image_urls: references } : {}),
  };
}
export async function submitThemeImage(model: string, kind: 'hero' | 'atmosphere', proposal: ThemeProposal, references: string[]) {
  if (model !== aiSettings().imageModel || !/^openai\/gpt-image-[a-zA-Z0-9.\/-]+\/text-to-image$/.test(model)) throw new ProviderError('THEME_MODEL_UNSUPPORTED', 'Skonfigurowany model nie obsługuje generowania oprawy.');
  const endpoint = references.length ? model.replace('/text-to-image', '/edit') : model;
  const response = await fetch(`https://queue.fal.run/${endpoint}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Key ${process.env.FAL_KEY || process.env.FAL_API_KEY}`, 'Content-Type': 'application/json', 'X-Fal-No-Retry': '1', 'x-app-fal-disable-fallback': 'true', 'x-fal-object-lifecycle-preference': JSON.stringify({ expiration_duration_seconds: 86400 }) },
    body: JSON.stringify(collectionImageInput(kind, proposal, references)),
  });
  if ([400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status)) throw new ProviderError('THEME_PROVIDER_REJECTED', 'Usługa grafiki odrzuciła zlecenie. Sprawdź konfigurację i dostępność usługi.');
  if (!response.ok) throw new ProviderError('THEME_SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia grafiki. Nie wysyłamy jej ponownie.', true);
  const body = await response.json() as { request_id?: string };
  if (!body.request_id) throw new ProviderError('THEME_SUBMISSION_UNCERTAIN', 'Nie potwierdzono identyfikatora grafiki.', true);
  return { requestId: body.request_id, model: endpoint };
}
export async function pollThemeImage(model: string, requestId: string, overrides: Partial<{
  status: (model: string, requestId: string) => Promise<{ status: string }>;
  result: (model: string, requestId: string) => Promise<{ data: unknown }>;
  bill: (requestId: string) => Promise<{ chargedUsd: string } | null>;
  download: (url: URL) => Promise<Response>;
  read: typeof readBounded;
}> = {}) {
  const statusFor = overrides.status ?? ((model, requestId) => imageClient().queue.status(model, { requestId, logs: false, abortSignal: AbortSignal.timeout(20_000) }));
  const resultFor = overrides.result ?? ((model, requestId) => imageClient().queue.result(model, { requestId, abortSignal: AbortSignal.timeout(20_000) }));
  const billFor = overrides.bill ?? imageBill;
  let receipt: { data: unknown };
  try {
    const status = await statusFor(model, requestId);
    if (status.status !== 'COMPLETED') return { done: false as const };
    receipt = await resultFor(model, requestId);
  } catch (error) {
    // A provider rejection of a known receipt is final. Transport failures,
    // rate limits and server failures can still be read again without a POST.
    if (error instanceof ApiError && [400, 404, 422].includes(error.status)) {
      const billed = await billFor(requestId).catch(() => null);
      throw new ProviderError('THEME_RESULT_FAILED', 'Usługa grafiki nie ukończyła tego zlecenia. Poprzednia oprawa została zachowana.', false, billed?.chargedUsd);
    }
    throw error;
  }
  const data = z.object({ images: z.array(z.object({ url: z.string().min(1) })).min(1) }).safeParse(receipt.data);
  if (!data.success) {
    const billed = await billFor(requestId).catch(() => null);
    throw new ProviderError('THEME_IMAGE_INVALID', 'Generator nie udostępnił grafiki.', false, billed?.chargedUsd);
  }
  const source = data.data.images[0].url;
  const url = approvedFalUrl(source);
  const response = await (overrides.download ?? (url => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store' })))(url);
  if (!response.ok) throw new Error('THEME_IMAGE_READ_FAILED');
  const bytes = await (overrides.read ?? readBounded)(response.body, 32 * 1024 * 1024);
  const billed = await billFor(requestId);
  return { done: true as const, bytes, chargedUsd: billed?.chargedUsd ?? null };
}
