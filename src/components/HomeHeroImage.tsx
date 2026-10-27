import { RecipeHeroImage } from './RecipeHeroImage';

export function HomeHeroImage({ src, alt }: { src: string; alt: string }) {
  return <RecipeHeroImage src={src} alt={alt} published loading="eager" fetchPriority="high"
    sizes="(max-width: 460px) calc(100vw - 40px), (max-width: 700px) min(440px, calc(92vw - 37px)), (max-width: 1100px) calc(53vw - 38px), min(700px, calc(53vw - 59px))" className="hero-food" />;
}
