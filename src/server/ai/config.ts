import 'server-only';

export function aiSettings() {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY), fal: Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY), storage: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    recipeModel: process.env.AI_RECIPE_MODEL || 'gpt-6-astra', imageModel: process.env.AI_IMAGE_MODEL || 'openai/gpt-image-2.5/sunburst/text-to-image',
    trendModel: process.env.AI_TREND_MODEL || 'gpt-6.1-sol',
    // Legacy DTO fields only. Spending caps and financial reservations were removed.
    recipeReservationUsd: '0.00000000', imageReservationUsd: '0.00000000',
    dailyLimitUsd: '0.00000000', monthlyLimitUsd: '0.00000000', pilotLimitUsd: '0.00000000',
    concurrentLimit: 2, maxInputBytes: 60_000, maxOutputTokens: 24_000,
  };
}

/** Compatibility helper: new requests never reserve money. */
export function recipeGenerationReservationUsd(): string {
  return '0.00000000';
}
