import type { EditorialContent } from '../../lib/editorial-types';

export const recipeDietVersion = 'ingredient-diet-v1';

/** A captured policy for new jobs; legacy receipts keep their original contract. */
export function recipeDietInstructions(input: EditorialContent): string[] {
  if (input.aiPhotography?.recipeDietVersion !== recipeDietVersion) return [];
  const target = input.aiPhotography.recipeDietTarget;
  return [`BASE RECIPE DIET
The application assigns exactly one category from the actual base ingredient list: meat (including fish, seafood, gelatin and other non-vegetarian animal ingredients), vegetarian (no non-vegetarian ingredients, but dairy, eggs or honey), or vegan (no animal ingredients). Optional substitutions never change the base recipe's category. A vegan recipe is the most specific category even though vegetarians can eat it. Specify compound ingredients precisely: animal or vegetable stock, fish-containing sauces, egg pasta, vegan alternatives and the required rennet in cheese. Traditional Parmesan/Parmigiano Reggiano, Grana Padano, Pecorino and Roquefort must not be described as vegetarian. If a vegetarian recipe uses another rennet cheese, explicitly require microbial/vegetarian rennet in the base ingredient name or an unconditional ingredient note. A note offering an optional vegetarian variation is insufficient. Do not infer that coconut milk, peanut butter or named plant alternatives contain dairy. Never conceal an animal ingredient in a sauce, seasoning, garnish or optional quantity.
${target ? `This dish was selected for the ${target} category. Its complete base ingredient list must actually match that exact category. Preserve the intended dish; do not remove defining ingredients, falsify the category or silently convert a meat dish to a plant dish to satisfy a quota. Report a conflict rather than inventing compliance.` : 'Preserve the intended dish and let its actual ingredients determine the category; do not convert it just to obtain a dietary label.'}
The application validates the ingredients before accepting the proposal. Clarify an ambiguous ingredient's actual formulation without adding health, allergen-free, certification or kitchen-testing claims. Do not add the category as commentary in the public cooking steps.`];
}
