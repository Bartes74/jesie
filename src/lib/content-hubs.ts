import type { Locale, Localised } from './recipes';
import type { PublicRecipe } from './recipe-presentation';

export interface CollectionDefinition {
  id: string;
  slug: Localised;
  title: Localised;
  description: Localised;
}
export interface PublishedCollection extends CollectionDefinition {
  recipes: PublicRecipe[];
  path: string;
  dateModified?: string;
}

export const collectionMinimum = 5;
export const collections: CollectionDefinition[] = [
  { id: 'quick-dinners', slug: { pl: 'obiady-do-30-minut', en: 'dinners-in-30-minutes' }, title: { pl: 'Obiady do 30 minut', en: 'Dinners in 30 minutes' }, description: { pl: 'Kiedy na gotowanie masz pół godziny. Wybierz danie według pełnego czasu przygotowania, sprawdź składniki i dopasuj liczbę porcji do swojego stołu.', en: 'For days when you have half an hour to cook. Choose a dish by its total preparation time, check the ingredients and adjust the servings to your table.' } },
  { id: 'one-pot', slug: { pl: 'jedna-patelnia-lub-garnek', en: 'one-pot-and-one-pan' }, title: { pl: 'Jedna patelnia lub garnek', en: 'One pot or one pan' }, description: { pl: 'Mniej naczyń, więcej czasu przy stole. Dania wybrane przez redakcję, których główne składniki przygotujesz razem w jednej patelni lub garnku.', en: 'Less washing-up, more time at the table. Dishes selected by the editors whose main ingredients cook together in one pot or pan.' } },
  { id: 'pantry', slug: { pl: 'gotowanie-z-tego-co-masz', en: 'cook-with-what-you-have' }, title: { pl: 'Gotowanie z tego, co masz', en: 'Cook with what you have' }, description: { pl: 'Zacznij od produktów, które czekają w kuchni. Te przepisy pomagają wykorzystać dostępne składniki; brakujące produkty i zaakceptowane zamienniki sprawdzisz przed gotowaniem.', en: 'Start with the food already in your kitchen. These recipes help you use available ingredients; check missing items and approved substitutions before cooking.' } },
  { id: 'seasonal', slug: { pl: 'sezonowe-obiady-i-zupy', en: 'seasonal-dinners-and-soups' }, title: { pl: 'Sezonowe obiady i zupy', en: 'Seasonal dinners and soups' }, description: { pl: 'Pomysły na obiad z sezonowych produktów dostępnych w Polsce. Przy każdym daniu sprawdź czas, sprzęt i sposób przygotowania, żeby wybrać przepis pasujący do Twojego dnia.', en: 'Dinner ideas using seasonal produce available in Poland. Check the time, equipment and method for each dish to find a recipe that fits your day.' } },
];

const dinnerCategories = new Set(['main', 'lunch', 'dinner', 'soup']);
export function collectionRecipes(collection: CollectionDefinition, recipes: readonly PublicRecipe[]): PublicRecipe[] {
  return recipes.filter(recipe => {
    if (collection.id === 'quick-dinners') return dinnerCategories.has(recipe.primaryCategory) && recipe.times.total > 0 && recipe.times.total <= 30;
    return recipe.seo?.collectionIds?.includes(collection.id) ?? false;
  });
}
export function getPublishedCollections(recipes: readonly PublicRecipe[], locale: Locale): PublishedCollection[] {
  return collections.flatMap(collection => {
    const selected = collectionRecipes(collection, recipes);
    if (selected.length < collectionMinimum) return [];
    // Recipe dates cannot describe removal from a collection; omit lastmod until
    // collection membership has its own publication history.
    return [{ ...collection, recipes: selected, path: `/${locale}/kolekcje/${collection.slug[locale]}` }];
  });
}

function ingredientNames(recipe: PublicRecipe) {
  return new Set(recipe.ingredients.map(item => item.name.pl.toLocaleLowerCase('pl').trim()));
}
export function getRelatedRecipes(recipe: PublicRecipe, recipes: readonly PublicRecipe[]): PublicRecipe[] {
  const available = recipes.filter(item => item.id !== recipe.id);
  const curated = (recipe.seo?.relatedRecipeIds ?? []).flatMap(id => available.find(item => item.id === id) ?? []);
  const names = ingredientNames(recipe);
  const scored = available.filter(item => !curated.some(selected => selected.id === item.id)).map(item => ({
    item,
    score: (item.primaryCategory === recipe.primaryCategory ? 3 : 0)
      + item.ingredients.filter(ingredient => names.has(ingredient.name.pl.toLocaleLowerCase('pl').trim()) && !/^(sól|pieprz|woda|oliwa|masło)$/.test(ingredient.name.pl.toLocaleLowerCase('pl').trim())).length * 2,
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return [...curated, ...scored.map(item => item.item)].slice(0, 3);
}

export interface Guide {
  slug: Localised;
  title: Localised;
  description: Localised;
  datePublished: string;
  dateModified: string;
  sections: { heading: Localised; paragraphs: Localised<string[]> }[];
  collectionIds: string[];
}
export const guides: Guide[] = [
  {
    slug: { pl: 'jak-przeliczac-porcje-przepisu', en: 'how-to-adjust-recipe-servings' },
    title: { pl: 'Jak przeliczać porcje przepisu', en: 'How to adjust recipe servings' },
    description: { pl: 'Zmiana liczby porcji w jesie.pl: ilości składników, jednostki, rozmiar naczynia i czas gotowania. Sprawdź, co przelicza się automatycznie, a co wymaga Twojej uwagi.', en: 'Adjusting servings on jesie.pl: ingredient quantities, units, cookware and cooking time. See what updates automatically and what still needs your attention.' },
    datePublished: '2026-10-12T20:00:00Z', dateModified: '2026-10-12T20:00:00Z', collectionIds: ['quick-dinners', 'pantry'],
    sections: [
      { heading: { pl: 'Zacznij od liczby osób', en: 'Start with the number of people' }, paragraphs: { pl: ['Na stronie przepisu wybierz liczbę porcji. Lista składników i odwołania do ilości w instrukcji korzystają z tego samego przeliczenia, więc podczas gotowania nie musisz liczyć wszystkiego ponownie.', 'Przykład: jeśli przepis bazowy jest dla czterech osób, a gotujesz dla dwóch, składniki przeliczane proporcjonalnie zmniejszą się o połowę. Uwagi przy składnikach i opis porcji nadal warto przeczytać przed rozpoczęciem.'], en: ['Choose the number of servings on the recipe page. The ingredient list and quantities referenced in the method use the same calculation, so you do not need to work everything out again while cooking.', 'For example, if the original recipe serves four and you are cooking for two, ingredients marked for proportional scaling are halved. Read the ingredient notes and serving description before starting.'] } },
      { heading: { pl: 'Nie każda ilość zmienia się tak samo', en: 'Not every quantity changes the same way' }, paragraphs: { pl: ['Woda do gotowania, tłuszcz do posmarowania naczynia lub ilość potrzebna do przykrycia składników mogą być stałe. Przelicznik respektuje sposób skalowania zapisany dla danego składnika; opis „do smaku” pozostaje wskazówką, a nie dokładną gramaturą.', 'Jeśli po przeliczeniu widzisz ułamek sztuki, potraktuj go jako proporcję. Przy jajkach, owocach i innych produktach o różnej wielkości sprawdź notatkę w przepisie. Wypieki wymagają szczególnej uwagi: proporcje składników i wielkość formy mają znaczenie dla efektu.'], en: ['Cooking water, grease for a dish or liquid needed to cover ingredients may have a fixed amount. The calculator respects the scaling rule saved for each ingredient; “to taste” remains guidance rather than an exact weight.', 'If scaling produces a fraction of an item, treat it as a proportion. For eggs, fruit and other ingredients of varying sizes, check the recipe note. Baking needs particular care: both ingredient ratios and tin size affect the result.'] } },
      { heading: { pl: 'Sprawdź naczynie i oznaki gotowości', en: 'Check your cookware and signs of doneness' }, paragraphs: { pl: ['Zmiana porcji nie przelicza automatycznie czasu ani temperatury. Większa ilość może wymagać większego garnka albo pracy partiami. Kieruj się instrukcją i opisanymi oznakami gotowości, zamiast mnożyć minuty przez liczbę porcji.', 'Na końcu możesz skopiować listę zakupów lub wydrukować przepis z aktualnymi ilościami. Wybór jednostek UK zmienia prezentację ilości; przy wypiekach korzystaj z jednostek, które najlepiej odpowiadają Twojej wadze i miarkom.'], en: ['Changing servings does not automatically adjust cooking time or temperature. A larger batch may need a larger pan or cooking in batches. Follow the method and its signs of doneness rather than multiplying minutes by servings.', 'You can then copy the shopping list or print the recipe with the current quantities. Choosing UK units changes how amounts are displayed; for baking, use units that suit your scales and measuring tools.'] } },
    ],
  },
  {
    slug: { pl: 'jak-wybrac-obiad-z-tego-co-masz', en: 'how-to-choose-dinner-from-your-fridge' },
    title: { pl: 'Jak wybrać obiad z tego, co masz', en: 'How to choose dinner from what you have' },
    description: { pl: 'Praktyczny sposób wyboru przepisu według zawartości lodówki, czasu i liczby porcji. Zobacz brakujące składniki i sprawdź zamienniki przed gotowaniem.', en: 'A practical way to choose a recipe by your fridge contents, available time and servings. Check missing ingredients and substitutions before cooking.' },
    datePublished: '2026-10-12T20:00:00Z', dateModified: '2026-10-12T20:00:00Z', collectionIds: ['pantry', 'quick-dinners', 'one-pot'],
    sections: [
      { heading: { pl: 'Zacznij od produktów, które chcesz wykorzystać', en: 'Start with the ingredients you want to use' }, paragraphs: { pl: ['Zapisz produkty dostępne w kuchni w funkcji lodówki. Zacznij od składnika, wokół którego chcesz zbudować posiłek, a potem dodaj pozostałe produkty. Nie musisz z góry znać nazwy dania.', 'Dopasowanie przepisu to punkt wyjścia. Przed gotowaniem sprawdź pełną listę: postać produktu, ilość i wymagane przygotowanie. Surowy składnik i jego ugotowana wersja nie zawsze nadają się do tej samej instrukcji.'], en: ['Add ingredients available in your kitchen to the fridge feature. Start with the ingredient you want to build the meal around, then add the rest. You do not need to know the dish name in advance.', 'A recipe match is a starting point. Before cooking, check the full list: the ingredient form, amount and preparation required. Raw and cooked versions are not always interchangeable in the same method.'] } },
      { heading: { pl: 'Sprawdź braki i zamienniki', en: 'Check missing ingredients and substitutions' }, paragraphs: { pl: ['Porównaj dostępne produkty z listą przepisu. Niewielka liczba braków nie oznacza jeszcze, że wszystkie pozostałe ilości wystarczą na wybraną liczbę porcji. Skopiuj listę zakupów, jeśli potrzebujesz uzupełnić zapasy.', 'Zaakceptowane zamienniki znajdziesz przy składnikach. Przeczytaj też ich uwagi: zmiana produktu może wpłynąć na smak, konsystencję albo sposób przygotowania. Jeśli przepis nie podaje zamiennika, nie traktuj podobnej nazwy jako potwierdzenia, że zamiana zadziała.'], en: ['Compare your available food with the recipe list. Only a few missing items does not mean you have enough of everything else for the servings you want. Copy the shopping list if you need to replenish supplies.', 'Approved substitutions appear alongside the ingredients. Read their notes too: changing an ingredient may affect flavour, texture or preparation. If a substitution is not listed, a similar name is not confirmation that it will work.'] } },
      { heading: { pl: 'Dopasuj przepis do swojego dnia', en: 'Match the recipe to your day' }, paragraphs: { pl: ['Sprawdź pełny czas przygotowania i sprzęt. W krótkim oknie na obiad ważny jest czas od rozpoczęcia do podania, razem z gotowaniem i odpoczynkiem, a nie tylko minuty pracy przy blacie.', 'Ustaw porcje przed rozpoczęciem. Odhaczaj przygotowane składniki i ukończone kroki, a po posiłku zapisz przepis w ulubionych, jeśli chcesz do niego wrócić. Przy następnym wyborze dania możesz zacząć od sprawdzonej przez siebie listy.'], en: ['Check the total preparation time and equipment. When dinner needs to fit into a short window, the time from starting to serving matters, including cooking and resting, not just hands-on minutes.', 'Set servings before starting. Tick off prepared ingredients and completed steps, then save the recipe if you want to return to it. Next time you choose a meal, you can start with your own favourites.'] } },
    ],
  },
];
export function getGuideHref(guide: Guide, locale: Locale) { return `/${locale}/poradniki/${guide.slug[locale]}`; }
