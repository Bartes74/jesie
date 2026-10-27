/** Visually reviewed mismatches stay unavailable even if their old job label
 * names the intended ingredient. Historical pixels and receipts remain intact.
 */
export const reviewedIncompatibleIngredientPhotoSources: ReadonlySet<string> = new Set([
  '/media/9ea9e5cb-0b8c-4e6d-8052-45e374ab5505', // Dry red wine was rendered as dried flakes.
  '/media/9590f1bc-1ee4-4577-a156-7d2e738d6e64', // Rejected dry white wine flakes.
  '/media/09575620-d92a-43b6-bec9-e2f32b8f31aa', // Whole/seeded squash instead of peeled, seedless flesh.
]);
import { ingredientPhotoIdentitiesCompatible, ingredientPhotoSemanticIdentity, type IngredientPhotoSemanticIdentity, type IngredientPhotoSubject } from './ingredient-photo-identity';


/** Actual reviewed pixels take precedence over an inaccurate historical label. */
export const reviewedIngredientPhotoIdentities: ReadonlyMap<string, IngredientPhotoSemanticIdentity> = new Map([
  ['/media/7ca03eb5-9c93-4bc9-a757-2ace68688d03', { product: 'garlic', forms: ['whole', 'unpeeled'] }],
]);

export function reviewedIngredientPhotoCompatible(src:string,captured:IngredientPhotoSubject,target:IngredientPhotoSubject):boolean{
  return !reviewedIncompatibleIngredientPhotoSources.has(src)&&ingredientPhotoIdentitiesCompatible(
    reviewedIngredientPhotoIdentities.get(src)??ingredientPhotoSemanticIdentity(captured),ingredientPhotoSemanticIdentity(target));
}
