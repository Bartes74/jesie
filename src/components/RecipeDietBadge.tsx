import { Beef, Leaf, Sprout } from 'lucide-react';
import { getRecipeDiet, recipeDiets, type RecipeDietId } from '@/lib/recipe-diet';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import './recipe-diet.css';

const DIET_ICONS = { meat: Beef, vegetarian: Leaf, vegan: Sprout };

export function RecipeDietIcon({ diet }: { diet: RecipeDietId }) {
  const Icon = DIET_ICONS[diet];
  return <Icon size={15} strokeWidth={1.6} aria-hidden="true" />;
}

export function RecipeDietBadge({ recipe, locale, showLabel = false }: { recipe: PublicRecipe; locale: Locale; showLabel?: boolean }) {
  const diet = getRecipeDiet(recipe);
  const label = recipeDiets.find(item => item.id === diet)!.label[locale];
  const description = diet === 'meat' ? locale === 'pl' ? 'Z mięsem, rybami lub innymi składnikami niewegetariańskimi' : 'Contains meat, fish or other non-vegetarian ingredients' : label;
  return <span className={`recipe-diet-badge${showLabel ? ' has-label' : ''}`} data-diet={diet} role={showLabel ? undefined : 'img'} aria-label={showLabel ? undefined : description} title={description}>
    <RecipeDietIcon diet={diet} />{showLabel && <span>{label}</span>}
  </span>;
}
