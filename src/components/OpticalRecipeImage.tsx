'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import type { MediaDeliveryWidth } from '@/lib/media-delivery';
import { heroOpticalLayout } from '@/lib/hero-optical-layout';
import { measureRecipeImageFootprint } from '@/lib/recipe-image-footprint';
import { MediaImage } from './MediaImage';

export type OpticalRecipeImageProps = {
  src: string;
  alt: string;
  sizes: string;
  maximumWidth?: MediaDeliveryWidth;
  className?: string;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  style?: CSSProperties;
  surface?: 'hero' | 'card';
};

/** Size the visible dish within its frame, including card padding and hover clearance. */
export function OpticalRecipeImage({ src, alt, sizes, maximumWidth = 1600, className, loading = 'lazy', fetchPriority, style, surface = 'hero' }: OpticalRecipeImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const image = imageRef.current;
    const frame = frameRef.current;
    if (!image || !frame) return;
    let footprint: (NonNullable<ReturnType<typeof measureRecipeImageFootprint>> & { naturalWidth: number; naturalHeight: number }) | null = null;
    const reset = () => {
      image.style.removeProperty('scale');
      image.style.removeProperty('translate');
      image.style.removeProperty('transform-origin');
      delete frame.dataset.cutout;
    };
    const resize = () => {
      if (!footprint) { reset(); return; }
      const computed = getComputedStyle(image);
      const padding = { left: parseFloat(computed.paddingLeft) || 0, right: parseFloat(computed.paddingRight) || 0,
        top: parseFloat(computed.paddingTop) || 0, bottom: parseFloat(computed.paddingBottom) || 0 };
      const geometry = { naturalWidth: footprint.naturalWidth, naturalHeight: footprint.naturalHeight,
        boxWidth: image.clientWidth, boxHeight: image.clientHeight, alphaBounds: footprint.bounds,
        foregroundArea: footprint.foregroundArea, padding, surface };
      const layout = heroOpticalLayout(geometry);
      image.style.transformOrigin = `${layout.originX}px ${layout.originY}px`;
      image.style.translate = `${layout.translateX}px ${layout.translateY}px`;
      image.style.scale = String(layout.scale);
      // Transparent cutouts receive a drop shadow traced from their own alpha contour.
      frame.dataset.cutout = '';
    };
    const measure = () => {
      footprint = null;
      if (image.naturalWidth && image.naturalHeight) {
        try {
          const canvas = document.createElement('canvas');
          const { naturalWidth, naturalHeight } = image;
          const ratio = Math.min(1, 192 / Math.max(naturalWidth, naturalHeight));
          canvas.width = Math.max(1, Math.round(naturalWidth * ratio));
          canvas.height = Math.max(1, Math.round(naturalHeight * ratio));
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const measured = measureRecipeImageFootprint({ pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
              width: canvas.width, height: canvas.height, naturalWidth, naturalHeight });
            if (measured) footprint = { ...measured, naturalWidth, naturalHeight };
          }
        } catch { /* Opaque or unavailable pixels keep the existing complete-image layout. */ }
      }
      resize();
    };
    const onError = () => { footprint = null; reset(); };
    image.addEventListener('load', measure);
    image.addEventListener('error', onError);
    if (image.complete) measure();
    const observer = new ResizeObserver(resize);
    observer.observe(image);
    return () => { image.removeEventListener('load', measure); image.removeEventListener('error', onError); observer.disconnect(); reset(); };
  }, [src, surface]);

  return <div ref={frameRef} className="recipe-dish-frame" style={{ position: 'absolute', inset: 0, overflowX: 'clip' }}>
    <MediaImage ref={imageRef} src={src} alt={alt} fill loading={loading} fetchPriority={fetchPriority} maximumWidth={maximumWidth}
      sizes={sizes} className={className} style={style} />
  </div>;
}
