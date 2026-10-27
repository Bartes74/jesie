import { createHash } from 'node:crypto';
import { ingredientIdentityParts, ingredientPhotoIdentitiesCompatible, ingredientPhotoSemanticIdentity } from '@/lib/ingredient-photo-identity';
import type { Ingredient } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { getIngredientImage, type MediaTile } from '@/lib/recipe-media';
import { lemonIngredientPhotoForm, lemonIngredientPhotoIssue, lemonPhotoSources } from '@/lib/citrus-photo-policy';
import { knownStaticIngredientPhotoIdentity, staticIngredientPhotoOverride } from '@/lib/static-ingredient-photos';

/** A shared photographic direction; storage in an atlas does not change its style. */
export const ingredientStyleProfile = 'jesie-ingredient-editorial-v1';
export const legacyIngredientStyleProfile = ingredientStyleProfile;
export const whiteIngredientStyleProfile = 'jesie-ingredient-white-studio-v2';
export const whiteIngredientReservationUsd = '0.00000000';
export const paperIngredientStyleProfile = 'jesie-ingredient-paper-studio-v3';
export const ingredientStudioBackgroundHex = '#FAF8F2';
export const currentIngredientStyleProfile = paperIngredientStyleProfile;
export const paperIngredientReservationUsd = whiteIngredientReservationUsd;
export function isOpaqueStudioIngredientProfile(profile: string) {
  return profile === whiteIngredientStyleProfile || profile === paperIngredientStyleProfile;
}
/** Missing markers preserve the meaning of every previously accepted job. */
export function capturedIngredientStyleProfile(input: Pick<EditorialContent, 'aiPhotography'>) {
  const profile = input.aiPhotography?.ingredientStyleProfile;
  return profile === paperIngredientStyleProfile ? paperIngredientStyleProfile : profile === whiteIngredientStyleProfile ? whiteIngredientStyleProfile : legacyIngredientStyleProfile;
}
export type IngredientImageIdentity = { key: string; product: string; form: string; styleProfile: string };

export function ingredientImageIdentity(ingredient: Pick<Ingredient,'name'|'note'>, styleProfile=ingredientStyleProfile): IngredientImageIdentity {
  const { product, form } = ingredientIdentityParts(ingredient);
  const key=createHash('sha256').update(`${styleProfile}\n${product}\n${form}`).digest('hex');
  return {key,product,form,styleProfile};
}

/** Physical form instructions do not change any historical captured image key. */
export function ingredientPhotographyForm(ingredient: Pick<Ingredient, 'name' | 'note'>, styleProfile=ingredientStyleProfile) {
  const identity = ingredientImageIdentity(ingredient, styleProfile);
  const semantic=ingredientPhotoSemanticIdentity(ingredient);
  if((semantic.product==='red-wine'||semantic.product==='white-wine')&&!semantic.forms.includes('dried'))return `liquid ${semantic.product==='red-wine'?'red':'white'} wine, ${semantic.product==='red-wine'?'clear ruby red':'clear pale straw'} colour, poured into one small neutral glass vessel; dry means low sweetness, never flakes, powder or dried food`;
  if (identity.product === 'white-wine' && identity.form === 'plain') return 'liquid white wine, clear pale straw colour, poured into one small neutral glass vessel; dry means low sweetness, never flakes, powder or dried food';
  if (identity.product === 'whipping-cream' && /^fat-\d+(?:\.\d+)?$/.test(identity.form)) return `pourable liquid unwhipped cream, ${identity.form.replace('fat-', '')}% fat, in one simple small neutral vessel; a smooth level liquid surface, never whipped peaks, dollops or stiff cream`;
  return semantic.forms.length ? semantic.forms.join(', ') : 'the ingredient as named, uncooked unless its name explicitly specifies a cooked product';
}

export function staticIngredientCandidates() {
  const candidates=new Map<string,{identity:IngredientImageIdentity;photo:MediaTile}>();
  for(const recipe of recipes)for(const ingredient of recipe.ingredients){
    const identity=ingredientImageIdentity(ingredient, legacyIngredientStyleProfile); const photo=getIngredientImage(recipe.id,ingredient.id);
    if(lemonIngredientPhotoIssue(ingredient,photo))continue;
    const source=knownStaticIngredientPhotoIdentity(photo);
    if(!source||!ingredientPhotoIdentitiesCompatible(source,ingredientPhotoSemanticIdentity(ingredient)))continue;
    candidates.set(identity.key,{identity,photo});
  }
  return candidates;
}
export function staticIngredientPhoto(ingredient: Ingredient, styleProfile=ingredientStyleProfile):MediaTile|null {
  if(styleProfile===legacyIngredientStyleProfile){const replacement=staticIngredientPhotoOverride('',ingredient);if(replacement)return replacement;}
  const form=lemonIngredientPhotoForm(ingredient);
  if(styleProfile===legacyIngredientStyleProfile&&(form==='juice'||form==='zest'))return {
    src:lemonPhotoSources[form],columns:1,rows:1,index:0,alt:structuredClone(ingredient.name),
  };
  const identity=ingredientImageIdentity(ingredient,styleProfile);const candidate=staticIngredientCandidates().get(identity.key);
  return candidate?{...structuredClone(candidate.photo),alt:structuredClone(ingredient.name)}:null;
}
