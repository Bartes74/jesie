import { OpticalRecipeImage, type OpticalRecipeImageProps } from './OpticalRecipeImage';

type RecipeHeroImageProps = OpticalRecipeImageProps & { published: boolean };

/** Public photographs and private previews share the same complete-dish presentation. */
export function RecipeHeroImage(props: RecipeHeroImageProps) {
  return <OpticalRecipeImage {...props} />;
}
