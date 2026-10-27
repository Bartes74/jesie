import { BlobError, BlobServiceNotAvailable, BlobServiceRateLimited } from '@vercel/blob';
import { ProviderError } from './provider-error';

/** Retry only after a provider receipt exists; immutable asset paths make the storage retry safe. */
export function isTransientPhotoResultRead(error: unknown): boolean {
  return error instanceof BlobServiceNotAvailable || error instanceof BlobServiceRateLimited
    || error instanceof ProviderError && error.code === 'AI_IMAGE_DOWNLOAD_UNAVAILABLE';
}

/** A storage failure after an accepted receipt never proves that generation failed. */
export function photoResultRecoveryError(error: unknown): ProviderError | null {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof BlobError)) return null;
  const capacity = /(?:storage quota exceeded|storage limit|store is full)/i.test(error.message);
  return new ProviderError(capacity ? 'AI_RESULT_STORAGE_CAPACITY' : 'AI_RESULT_STORAGE_UNAVAILABLE',
    capacity ? 'Zdjęcie jest gotowe u dostawcy, ale brakuje miejsca na jego zapis. Po zwolnieniu miejsca kontynuuj ten sam pakiet; odczytamy istniejący wynik.'
      : 'Zdjęcie jest gotowe u dostawcy, ale magazyn nie pozwala go teraz zapisać. Po przywróceniu dostępu kontynuuj ten sam pakiet; odczytamy istniejący wynik.', true);
}
