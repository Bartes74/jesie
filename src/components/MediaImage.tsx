import Image from 'next/image';
import type { CSSProperties, ReactEventHandler, Ref } from 'react';
import { isRegisteredMediaSource, mediaDeliverySrc, mediaDeliverySrcSet, type MediaDeliveryWidth } from '@/lib/media-delivery';
import { isLegacyMediaSource, legacyMediaDeliverySrc, legacyMediaDeliverySrcSet } from '@/lib/legacy-media-delivery';

type MediaImageProps = {
  ref?: Ref<HTMLImageElement>;
  src: string;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  sizes?: string;
  maximumWidth?: MediaDeliveryWidth;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  decoding?: 'async' | 'sync' | 'auto';
  className?: string;
  style?: CSSProperties;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  onError?: ReactEventHandler<HTMLImageElement>;
};
const fillStyle: CSSProperties = { position: 'absolute', width: '100%', height: '100%', inset: 0 };

/** Native same-origin delivery retains sessions and reuses saved registered or static variants. */
export function MediaImage({ ref, src, alt, width, height, fill = false, sizes, maximumWidth = 1280, loading = 'lazy', fetchPriority, decoding = 'async', className, style, onLoad, onError }: MediaImageProps) {
  if (/^\/media\/collections\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(src)) {
    const widths = [320, 640, 960, 1280, 1600].filter(value => value <= Math.max(320, maximumWidth));
    // eslint-disable-next-line @next/next/no-img-element
    return <img ref={ref} src={`${src}?w=${widths.at(-1)}`} srcSet={widths.map(value => `${src}?w=${value} ${value}w`).join(', ')} sizes={sizes} alt={alt} width={width} height={height} loading={loading} fetchPriority={fetchPriority} decoding={decoding} className={className} style={fill ? { ...fillStyle, ...style } : style} onLoad={onLoad} onError={onError} />;
  }
  const registered = isRegisteredMediaSource(src);
  if (registered || isLegacyMediaSource(src)) {
    const deliverySrc = registered ? mediaDeliverySrc(src, maximumWidth) : legacyMediaDeliverySrc(src, maximumWidth);
    const srcSet = registered ? mediaDeliverySrcSet(src, maximumWidth) : legacyMediaDeliverySrcSet(src, maximumWidth);
    // eslint-disable-next-line @next/next/no-img-element
    return <img ref={ref} src={deliverySrc} srcSet={srcSet} sizes={sizes} alt={alt} width={width} height={height} loading={loading} fetchPriority={fetchPriority} decoding={decoding} className={className} style={fill ? { ...fillStyle, ...style } : style} onLoad={onLoad} onError={onError} />;
  }
  const privateCollectionAsset = /^\/api\/admin\/collections\/[^/]+\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(src);
  return <Image ref={ref} src={src} alt={alt} width={width} height={height} fill={fill} sizes={sizes} unoptimized={src.startsWith('/media/') || privateCollectionAsset} loading={loading} fetchPriority={fetchPriority} decoding={decoding} className={className} style={style} onLoad={onLoad} onError={onError} />;
}
