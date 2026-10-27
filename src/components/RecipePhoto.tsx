import Image from "next/image";
import type { Locale } from "@/lib/recipes";
import type { MediaTile } from "@/lib/recipe-media";
import { photoViewportLayout } from "@/lib/recipe-photo-layout";
import { isRegisteredMediaSource, type MediaDeliveryWidth } from '@/lib/media-delivery';
import { isLegacyMediaSource, legacyMediaAtlasMaximumWidth } from '@/lib/legacy-media-delivery';
import { MediaImage } from './MediaImage';

/** The original photographic atlas stays intact; the viewport displays one subject. */
export function RecipePhoto({ media, locale, className = "", sizes, legacySizes, maximumWidth = 1280, decorative = false, viewportAspectRatio }: { media: MediaTile; locale: Locale; className?: string; sizes: string; legacySizes?: string; maximumWidth?: MediaDeliveryWidth; decorative?: boolean; viewportAspectRatio?: number }) {
  const layout = photoViewportLayout(media, viewportAspectRatio, decorative);
  const aspectRatio = viewportAspectRatio ?? media.aspectRatio;
  const imageStyle = { position: 'absolute' as const, width: `${layout.width}%`, height: `${layout.height}%`, maxWidth: 'none', left: `${layout.left}%`, top: `${layout.top}%`, objectFit: 'fill' as const };
  const width = Math.round(media.columns * 320 * (media.aspectRatio ?? 1));
  const height = media.rows * 320;
  const registered = isRegisteredMediaSource(media.src);
  const legacy = isLegacyMediaSource(media.src);
  return <span className={`recipe-photo-viewport ${className}`} style={aspectRatio ? { aspectRatio } : undefined}>
    {registered || legacy
      ? <MediaImage src={media.src} alt={decorative ? '' : media.alt[locale]} width={width} height={height} maximumWidth={legacy ? legacyMediaAtlasMaximumWidth(maximumWidth, layout.width) : maximumWidth} sizes={registered ? sizes : legacySizes ?? sizes} style={imageStyle} />
      : <Image src={media.src} unoptimized={media.src.startsWith('/media/')} alt={decorative ? '' : media.alt[locale]} width={width} height={height} loading="lazy" decoding="async" sizes={legacySizes ?? sizes} style={imageStyle} />}
  </span>;
}
