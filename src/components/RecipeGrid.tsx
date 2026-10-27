import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import { formatRecipeDuration } from '@/lib/recipe-duration';
import Link from 'next/link';
import { RecipeHeroImage } from './RecipeHeroImage';
import { getRecipeHref, type Locale } from '@/lib/recipes';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { RecipeDietBadge } from './RecipeDietBadge';

export function RecipeGrid({ recipes, locale }: { recipes: readonly PublicRecipe[]; locale: Locale }) {
  return <div className="hub-recipe-grid">{recipes.map(recipe => <article key={recipe.id}>
    <Link href={getRecipeHref(recipe, locale)}><div className="hub-recipe-image"><RecipeHeroImage src={recipe.image} published alt={recipe.imageAlt[locale]} sizes="(max-width: 700px) calc(100vw - 40px), (max-width: 1000px) calc((100vw - 98px) / 2), (max-width: 1100px) calc((100vw - 124px) / 3), min(423px, calc((100vw - 164px) / 3))" maximumWidth={960} surface="card" /></div><h2>{recipe.title[locale]}</h2></Link>
    <p>{formatRecipeDurationText(recipe.description[locale], locale)}</p><span className="hub-recipe-diet"><RecipeDietBadge recipe={recipe} locale={locale} />{formatRecipeDuration(recipe.times.total, locale)} · {recipe.baseServings} {locale === 'pl' ? 'porcji bazowych' : 'base servings'}</span>
  </article>)}</div>;
}
