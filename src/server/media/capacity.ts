import 'server-only';
import { get, list } from '@vercel/blob';
import { ProviderError } from '@/server/ai/provider-error';

export const hobbyMaximumBytes = 1_000_000_000;
export const imageCapacityHeadroom = 64 * 1024 * 1024;

/** An explicit local safety guard, independent of the provider's plan and billing limits. */
export function photoStorageMaximumBytes(configured = process.env.BLOB_STORAGE_LIMIT_BYTES): number {
  if (configured === undefined) return hobbyMaximumBytes;
  // A typo must stop admission, rather than silently remove or enlarge the guard.
  const maximum = configured === configured.trim() && /^[1-9][0-9]*$/.test(configured) ? Number(configured) : NaN;
  if (!Number.isSafeInteger(maximum) || maximum <= imageCapacityHeadroom) {
    throw new ProviderError('AI_STORAGE_CONFIGURATION', 'Nieprawidłowy lokalny limit magazynu zdjęć. Ustaw BLOB_STORAGE_LIMIT_BYTES jako całkowitą liczbę bajtów większą niż 64 MiB. Nie wysłano płatnego zlecenia.');
  }
  return maximum;
}

/** Probe read access and reserve room for both concurrently admitted photographs. */
type CapacityDependencies = {
  list: (cursor?: string) => Promise<{ blobs: { pathname: string; size: number }[]; hasMore: boolean; cursor?: string }>;
  read: (pathname: string) => Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
};
export async function ensurePhotoStorageAvailable(dependencies: CapacityDependencies = {
  list: (cursor?: string) => list({ limit: 1000, ...(cursor ? { cursor } : {}) }),
  read: (pathname: string) => get(pathname, { access: 'private', useCache: false }),
}) {
  let total = 0, cursor: string | undefined, first: string | undefined;
  try {
    const maximum = photoStorageMaximumBytes();
    do {
      const page = await dependencies.list(cursor);
      for (const blob of page.blobs) { total += blob.size; first ??= blob.pathname; }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (total > maximum - imageCapacityHeadroom) throw new ProviderError('AI_STORAGE_CAPACITY', 'Magazyn zdjęć osiągnął lokalny limit bezpieczeństwa. Sprawdź zajęte miejsce i limit BLOB_STORAGE_LIMIT_BYTES zgodny z aktualnym planem oraz budżetem. Nie wysłano płatnego zlecenia.');
    if (first) {
      const probe = await dependencies.read(first);
      if (!probe || probe.statusCode !== 200 || !probe.stream) throw new Error('STORAGE_UNAVAILABLE');
      await probe.stream.cancel();
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('AI_STORAGE_UNAVAILABLE', 'Magazyn zdjęć jest niedostępny. Poczekaj na przywrócenie dostępu i ponów odczyt istniejących wyników. Nie wysłano płatnego zlecenia.');
  }
}
