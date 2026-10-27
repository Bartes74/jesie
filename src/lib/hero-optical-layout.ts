export type HeroAlphaBounds = { x: number; y: number; width: number; height: number };

export type HeroOpticalLayout = {
  naturalWidth: number;
  naturalHeight: number;
  boxWidth: number;
  boxHeight: number;
  /** Bounds of every retained alpha pixel, measured in the natural image's coordinates. */
  alphaBounds: HeroAlphaBounds;
  /** Silhouette support area (alpha > 0), measured in square natural-image pixels. */
  foregroundArea: number;
  /** CSS padding inside the image's border box, before object-fit: contain is applied. */
  padding?: { left: number; right: number; top: number; bottom: number };
  surface?: 'hero' | 'card';
};

export type HeroOpticalTransform = {
  scale: number;
  translateX: number;
  translateY: number;
  originX: number;
  originY: number;
};

// A circle occupying 92% of a square supplies the established plate reference.
const referenceDishArea = Math.PI * (0.92 / 2) ** 2;

/** Match visible dish area where possible, keeping the complete silhouette inside its frame. */
export function heroOpticalLayout({ naturalWidth, naturalHeight, boxWidth, boxHeight, alphaBounds, foregroundArea,
  padding = { left: 0, right: 0, top: 0, bottom: 0 }, surface = 'hero' }: HeroOpticalLayout): HeroOpticalTransform {
  const frameCentreX = Number.isFinite(boxWidth) ? boxWidth / 2 : 0;
  const frameCentreY = Number.isFinite(boxHeight) ? boxHeight / 2 : 0;
  const fallback = { scale: 1, translateX: 0, translateY: 0, originX: frameCentreX, originY: frameCentreY };
  const { x, y, width, height } = alphaBounds;
  const boundsArea = width * height;
  if (![naturalWidth, naturalHeight, boxWidth, boxHeight, width, height, foregroundArea, boundsArea].every(value => Number.isFinite(value) && value > 0)
    || ![x, y].every(value => Number.isFinite(value) && value >= 0)
    || ![padding.left, padding.right, padding.top, padding.bottom].every(value => Number.isFinite(value) && value >= 0)
    || x + width > naturalWidth || y + height > naturalHeight
    || foregroundArea > boundsArea * (1 + 8 * Number.EPSILON)) return fallback;

  const contentWidth = boxWidth - padding.left - padding.right;
  const contentHeight = boxHeight - padding.top - padding.bottom;
  if (contentWidth <= 0 || contentHeight <= 0) return fallback;
  const containedScale = Math.min(contentWidth / naturalWidth, contentHeight / naturalHeight);
  const imageLeft = padding.left + (contentWidth - naturalWidth * containedScale) / 2;
  const imageTop = padding.top + (contentHeight - naturalHeight * containedScale) / 2;
  const originX = imageLeft + (x + width / 2) * containedScale;
  const originY = imageTop + (y + height / 2) * containedScale;
  const visibleArea = foregroundArea * containedScale ** 2;
  const targetArea = referenceDishArea * Math.min(contentWidth, contentHeight) ** 2;
  if (![originX, originY, visibleArea, targetArea].every(Number.isFinite) || visibleArea <= 0 || targetArea <= 0) return fallback;

  // Cards retain room for their existing hover enlargement and rotation.
  const safeWidth = boxWidth * (surface === 'card' ? 0.9 : 0.96);
  const safeHeight = boxHeight * (surface === 'card' ? 0.84 : 0.92);
  const fitScale = Math.min(safeWidth / (width * containedScale), safeHeight / (height * containedScale));
  const scale = Math.min(Math.sqrt(targetArea / visibleArea), fitScale);
  if (!Number.isFinite(scale) || scale <= 0) return fallback;
  // Scale and hover rotate around the actual subject centre; translating that
  // origin to the frame centre keeps off-centre canvases and padding predictable.
  return { scale, translateX: frameCentreX - originX, translateY: frameCentreY - originY, originX, originY };
}
