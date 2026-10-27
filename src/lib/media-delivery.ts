/** Shared by the browser and authenticated media route; every variant keeps the same asset ID. */
export const mediaDeliveryWidths = [96, 160, 320, 480, 640, 960, 1280, 1600] as const;
export type MediaDeliveryWidth = typeof mediaDeliveryWidths[number];
const registeredSource = /^\/media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function isRegisteredMediaSource(src: string): boolean {
  return registeredSource.test(src);
}

/** Undefined keeps the full-frame route; null rejects ambiguous or unsupported variants. */
export function parseMediaDeliveryWidth(search: URLSearchParams): MediaDeliveryWidth | undefined | null {
  const widths = search.getAll('w');
  const versions = search.getAll('d');
  if (!widths.length && !versions.length) return undefined;
  if (widths.length !== 1 || versions.length > 1 || versions.length === 1 && versions[0] !== '2') return null;
  return mediaDeliveryWidths.find(width => String(width) === widths[0]) ?? null;
}

export function mediaDeliverySrc(src: string, width: MediaDeliveryWidth): string {
  if (!isRegisteredMediaSource(src) || !(mediaDeliveryWidths as readonly number[]).includes(width)) return src;
  return `${src}?w=${width}&d=2`;
}

export function mediaDeliverySrcSet(src: string, maximumWidth: MediaDeliveryWidth = 1600): string | undefined {
  if (!isRegisteredMediaSource(src)) return undefined;
  return mediaDeliveryWidths.filter(width => width <= maximumWidth)
    .map(width => `${mediaDeliverySrc(src, width)} ${width}w`).join(', ') || undefined;
}
