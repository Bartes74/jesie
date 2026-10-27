import { mediaDeliveryWidths, type MediaDeliveryWidth } from './media-delivery';

/** Only existing public raster paths enter the render-once delivery route. */
export function legacyMediaRelativePath(src: string): string | null {
  if (src.length > 500 || src !== src.trim() || !/^\/images\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:webp|png|jpe?g)$/.test(src)) return null;
  return src.slice('/images/'.length);
}

export const isLegacyMediaSource = (src: string): boolean => legacyMediaRelativePath(src) !== null;

export function legacyMediaDeliverySrc(src: string, width: MediaDeliveryWidth): string {
  const relative = legacyMediaRelativePath(src);
  if (relative === null || !(mediaDeliveryWidths as readonly number[]).includes(width)) return src;
  return `/media/static/${relative}?w=${width}&d=1`;
}

export function legacyMediaDeliverySrcSet(src: string, maximumWidth: MediaDeliveryWidth = 1600): string | undefined {
  if (!isLegacyMediaSource(src)) return undefined;
  return mediaDeliveryWidths.filter(width => width <= maximumWidth)
    .map(width => `${legacyMediaDeliverySrc(src, width)} ${width}w`).join(', ') || undefined;
}

/** This new route has no unversioned legacy callers. Reject ambiguous cache identities. */
export function parseLegacyMediaDeliveryWidth(search: URLSearchParams): MediaDeliveryWidth | null {
  const widths = search.getAll('w'), versions = search.getAll('d');
  if (widths.length !== 1 || versions.length !== 1 || versions[0] !== '1') return null;
  return mediaDeliveryWidths.find(width => String(width) === widths[0]) ?? null;
}

/** A photo-sized cap must include the whole atlas that CSS positions behind its viewport. */
export function legacyMediaAtlasMaximumWidth(maximumWidth: MediaDeliveryWidth, atlasWidthPercent: number): MediaDeliveryWidth {
  if (!Number.isFinite(atlasWidthPercent) || atlasWidthPercent <= 100) return maximumWidth;
  const target = maximumWidth * atlasWidthPercent / 100;
  return mediaDeliveryWidths.find(width => width >= target) ?? 1600;
}
