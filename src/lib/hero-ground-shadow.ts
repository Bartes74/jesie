import type { HeroOpticalLayout, HeroOpticalTransform } from './hero-optical-layout';

export type HeroGroundShadowLayout = { centerX: number; centerY: number; width: number; height: number };

/** A smooth ground ellipse beneath the visible subject, independent of its alpha contour. */
export function heroGroundShadowLayout(input: HeroOpticalLayout, layout: HeroOpticalTransform): HeroGroundShadowLayout | null {
  const { naturalWidth, naturalHeight, boxWidth, boxHeight, alphaBounds, foregroundArea } = input;
  const { x, y, width, height } = alphaBounds;
  const padding = input.padding ?? { left: 0, right: 0, top: 0, bottom: 0 };
  if (![naturalWidth, naturalHeight, boxWidth, boxHeight, width, height, foregroundArea, layout.scale]
    .every(value => Number.isFinite(value) && value > 0)
    || ![x, y, padding.left, padding.right, padding.top, padding.bottom].every(value => Number.isFinite(value) && value >= 0)
    || ![layout.originX, layout.originY, layout.translateX, layout.translateY].every(Number.isFinite)
    || x + width > naturalWidth || y + height > naturalHeight
    || foregroundArea > width * height * (1 + 8 * Number.EPSILON)) return null;

  const contentWidth = boxWidth - padding.left - padding.right;
  const contentHeight = boxHeight - padding.top - padding.bottom;
  if (contentWidth <= 0 || contentHeight <= 0) return null;
  const containScale = Math.min(contentWidth / naturalWidth, contentHeight / naturalHeight);
  const imageTop = padding.top + (contentHeight - naturalHeight * containScale) / 2;
  const visibleWidth = width * containScale * layout.scale;
  const untransformedBottom = imageTop + (y + height) * containScale;
  const subjectBottom = layout.originY + layout.translateY + (untransformedBottom - layout.originY) * layout.scale;
  if (![visibleWidth, subjectBottom].every(Number.isFinite) || visibleWidth <= 0 || subjectBottom < 0 || subjectBottom > boxHeight) return null;

  const shadowWidth = Math.min(visibleWidth * 0.66, boxWidth * 0.65);
  const shadowHeight = Math.min(24, Math.max(6, boxHeight * 0.05));
  // Retain at most one pixel of separation and use the existing frame clearance.
  const offset = Math.min(1, Math.max(0, boxHeight - subjectBottom - shadowHeight / 2));
  return { centerX: boxWidth / 2, centerY: subjectBottom + offset, width: shadowWidth, height: shadowHeight };
}
