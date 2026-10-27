import type { MediaTile } from './recipe-media';
import type { HeroPresentation } from './hero-presentation';
import type { RecipeDietId } from './recipe-diet';

export type Locale = "pl" | "en";
export type UnitSystem = "metric" | "uk";
export type Localised<T = string> = { pl: T; en: T };

export type CategoryId =
  | "breakfast"
  | "brunch"
  | "lunch"
  | "starter"
  | "soup"
  | "main"
  | "dessert"
  | "afternoon"
  | "snack"
  | "dinner";

export interface Category {
  id: CategoryId;
  label: Localised;
}

export type IngredientAmount =
  | { kind: "exact"; value: string; approximate?: boolean }
  | { kind: "range"; min: string; max: string; approximate?: boolean }
  | { kind: "qualitative"; text: Localised };

export type IngredientUnit = "g" | "ml" | "count" | "tsp" | "tbsp" | null;

export interface Ingredient {
  id: string;
  name: Localised;
  amount: IngredientAmount;
  unit: IngredientUnit;
  scaling: "linear" | "fixed";
  group: Localised;
  note?: Localised;
}

export interface RecipeStep {
  id: string;
  title: Localised;
  /** Ingredient tokens contain amounts and units, never translated names. */
  text: Localised;
  timerMinutes?: number;
}

/** Optional alternatives stay separate from the quantities of the main recipe. */
export interface IngredientSubstitution {
  id: string;
  ingredientId: string;
  name: Localised;
  amount?: IngredientAmount;
  unit?: IngredientUnit;
  scaling?: "linear" | "fixed";
  note: Localised;
  status: "to_review" | "approved";
}

export interface Recipe {
  id: string;
  slug: Localised;
  title: Localised;
  description: Localised;
  image: string;
  imageAlt: Localised;
  /** null means an explicit unresolved AI suggestion; undefined is a legacy record. */
  heroPresentation?: HeroPresentation | null;
  primaryCategory: CategoryId;
  categories: CategoryId[];
  dietaryTags: { id: string; label: Localised; status: "to_review" }[];
  /** Exclusive classification of the base ingredients; absent on legacy records. */
  diet?: RecipeDietId;
  difficulty: "easy" | "medium";
  cuisine: Localised;
  baseServings: number;
  times: { active: number; cooking: number; rest: number; total: number };
  ingredients: Ingredient[];
  steps: RecipeStep[];
  equipment: Localised<string[]>;
  tips: Localised<string[]>;
  storage: Localised;
  scalingNote?: Localised;
  provenance: {
    type: "demo_ai" | "original" | "adapted" | "ai_draft";
    label: Localised;
    note: Localised;
    kitchenTested: boolean;
  };
  photos?: { ingredients: Record<string, MediaTile>; steps: Record<string, MediaTile> };
  featured: boolean;
  collection?: "author" | "trends";
  trendConfirmedAt?: string;
  substitutions?: IngredientSubstitution[];
  /** Curated discovery fields; legacy recipes use their normal title/description. */
  seo?: {
    title?: Localised;
    description?: Localised;
    keywords?: Localised<string[]>;
    collectionIds?: string[];
    relatedRecipeIds?: string[];
    questions?: { id: string; question: Localised; answer: Localised }[];
  };
  /** Injected from immutable publications, never from a draft save timestamp. */
  publication?: { datePublished: string; dateModified: string; author: string };
}

export const categories: Category[] = [
  { id: "breakfast", label: { pl: "Śniadanie", en: "Breakfast" } },
  { id: "brunch", label: { pl: "Brunch", en: "Brunch" } },
  { id: "lunch", label: { pl: "Lunch", en: "Lunch" } },
  { id: "starter", label: { pl: "Przystawka", en: "Starter" } },
  { id: "soup", label: { pl: "Zupa", en: "Soup" } },
  { id: "main", label: { pl: "Główne danie", en: "Main course" } },
  { id: "dessert", label: { pl: "Deser", en: "Dessert" } },
  { id: "afternoon", label: { pl: "Podwieczorek", en: "Afternoon treat" } },
  { id: "snack", label: { pl: "Przekąska", en: "Snack" } },
  { id: "dinner", label: { pl: "Kolacja", en: "Dinner" } },
];

const mainGroup = { pl: "Składniki", en: "Ingredients" };
const doughGroup = { pl: "Ciasto", en: "Dough" };
const fillingGroup = { pl: "Nadzienie", en: "Filling" };
const servingGroup = { pl: "Do podania", en: "To serve" };

function exact(
  id: string,
  pl: string,
  en: string,
  value: string,
  unit: IngredientUnit,
  group: Localised = mainGroup,
  note?: Localised,
  scaling: "linear" | "fixed" = "linear",
): Ingredient {
  return { id, name: { pl, en }, amount: { kind: "exact", value }, unit, scaling, group, note };
}

function qualitative(
  id: string,
  pl: string,
  en: string,
  text: Localised = { pl: "do smaku", en: "to taste" },
  group: Localised = mainGroup,
): Ingredient {
  return { id, name: { pl, en }, amount: { kind: "qualitative", text }, unit: null, scaling: "fixed", group };
}

function step(
  id: string,
  titlePl: string,
  titleEn: string,
  textPl: string,
  textEn: string,
  timerMinutes?: number,
): RecipeStep {
  return { id, title: { pl: titlePl, en: titleEn }, text: { pl: textPl, en: textEn }, timerMinutes };
}

const vegetarianTag = {
  id: "vegetarian",
  label: { pl: "Wegetariańskie", en: "Vegetarian" },
  status: "to_review" as const,
};

const demoProvenance: Recipe["provenance"] = {
  type: "demo_ai",
  label: { pl: "Opracowanie przepisu", en: "Recipe notes" },
  note: {
    pl: "Notatki redakcyjne do przepisu.",
    en: "Editorial notes for this recipe.",
  },
  kitchenTested: false,
};

export const recipes: Recipe[] = [
  {
    id: "lemon-pasta",
    slug: { pl: "cytrynowe-tagliatelle", en: "lemon-tagliatelle" },
    title: { pl: "Cytrynowe tagliatelle", en: "Lemon tagliatelle" },
    description: {
      pl: "Jedwabisty sos, świeża cytryna i kilka listków bazylii. Mało składników, dużo przyjemności.",
      en: "Silky sauce, fresh lemon and a few basil leaves. A short ingredient list with plenty of flavour.",
    },
    image: "/images/lemon-pasta.webp",
    imageAlt: { pl: "Tagliatelle w cytrynowym sosie z bazylią", en: "Tagliatelle in lemon sauce with basil" },
    primaryCategory: "main",
    categories: ["main", "lunch", "dinner"],
    dietaryTags: [vegetarianTag],
    difficulty: "easy",
    cuisine: { pl: "Inspiracja włoska", en: "Italian-inspired" },
    baseServings: 4,
    times: { active: 15, cooking: 10, rest: 0, total: 25 },
    ingredients: [
      exact("pasta", "tagliatelle, suche", "dried tagliatelle", "400", "g"),
      exact("butter", "masło", "butter", "40", "g"),
      exact("cream", "śmietanka 30%", "whipping cream", "200", "ml"),
      exact("cheese", "dojrzewający ser twardy, drobno starty", "mature hard cheese, finely grated", "60", "g", mainGroup, {
        pl: "Dla wersji wegetariańskiej wybierz ser z podpuszczką mikrobiologiczną. W podstawowej wersji użyj sera z podpuszczką mikrobiologiczną lub roślinną.",
        en: "For a vegetarian version, choose a cheese made with vegetarian rennet. For the base recipe, use cheese made with microbial or vegetarian rennet.",
      }),
      exact("lemon-zest", "skórka z umytej, niewoskowanej cytryny", "finely grated zest of an unwaxed lemon", "1", "count"),
      {
        id: "lemon-juice", name: { pl: "sok z cytryny", en: "lemon juice" },
        amount: { kind: "range", min: "20", max: "30" }, unit: "ml", scaling: "linear", group: mainGroup,
        note: { pl: "Zacznij od dolnej granicy i dopraw po połączeniu sosu.", en: "Start with the lower amount and adjust once the sauce is combined." },
      },
      exact("basil", "świeża bazylia", "fresh basil", "10", "g", servingGroup),
      qualitative("salt", "sól", "salt"),
      qualitative("pepper", "świeżo mielony pieprz", "freshly ground black pepper"),
      qualitative("pasta-water", "woda z gotowania makaronu", "pasta cooking water", { pl: "w razie potrzeby", en: "as needed" }),
    ],
    steps: [
      step("prep", "Przygotuj dodatki", "Prepare the flavourings", "Umyj cytrynę, drobno zetrzyj żółtą część skórki i wyciśnij sok. Zetrzyj ser i oderwij listki bazylii.", "Wash the lemon, finely grate the yellow zest and squeeze the juice. Grate the cheese and pick the basil leaves."),
      step("pasta", "Ugotuj makaron", "Cook the pasta", "W dużym garnku zagotuj osoloną wodę. Dodaj {{pasta}} tagliatelle i gotuj do al dente według czasu na opakowaniu. Przed odcedzeniem zachowaj trochę wody z gotowania.", "Bring a large pan of salted water to the boil. Add {{pasta}} of tagliatelle and cook until al dente, following the packet timing. Reserve some cooking water before draining."),
      step("sauce", "Zrób cytrynowy sos", "Make the lemon sauce", "Na szerokiej patelni rozpuść {{butter}} masła na małym ogniu. Dodaj skórkę cytrynową, następnie {{cream}} śmietanki. Podgrzewaj łagodnie przez 2 minuty; sos nie powinien gwałtownie wrzeć.", "Melt {{butter}} of butter in a wide frying pan over a low heat. Add the lemon zest, followed by {{cream}} of cream. Warm gently for 2 minutes without bringing it to a rapid boil.", 2),
      step("combine", "Połącz i dopraw", "Combine and season", "Zmniejsz ogień do minimum. Dodaj makaron, starty ser i sok z cytryny, zaczynając od dolnej granicy podanego zakresu. Mieszaj, dolewając wodę z makaronu po trochu, aż sos oblepi wstążki. Dopraw solą i pieprzem.", "Turn the heat down to its lowest setting. Add the pasta, grated cheese and lemon juice, starting with the lower amount in the range. Toss, adding the reserved water a little at a time, until the sauce coats the ribbons. Season with salt and pepper."),
      step("serve", "Podaj od razu", "Serve straight away", "Rozłóż na talerze i dodaj bazylię. Podawaj od razu, gdy sos jest jeszcze kremowy.", "Divide between plates and finish with the basil. Serve straight away while the sauce is creamy."),
    ],
    equipment: { pl: ["duży garnek", "szeroka patelnia", "drobna tarka", "durszlak"], en: ["large saucepan", "wide frying pan", "fine grater", "colander"] },
    tips: {
      pl: ["Nie ścieraj białej części skórki — może nadać sosowi gorycz.", "Woda z makaronu pomaga połączyć tłuszcz i ser w gładki sos. Dolewaj ją stopniowo."],
      en: ["Avoid grating the white pith, which can make the sauce bitter.", "Pasta water helps the fat and cheese form a smooth sauce. Add it gradually."],
    },
    storage: { pl: "Najlepiej przygotować tuż przed podaniem. Przy ponownym podgrzewaniu sos może wymagać odrobiny wody.", en: "Best made just before serving. The sauce may need a splash of water when reheated." },
    provenance: demoProvenance,
    featured: true,
  },
  {
    id: "pumpkin-soup",
    slug: { pl: "krem-z-pieczonej-dyni", en: "roasted-pumpkin-soup" },
    title: { pl: "Krem z pieczonej dyni", en: "Roasted pumpkin soup" },
    description: { pl: "Pieczona dynia, imbir i mleczko kokosowe. Rozgrzewająca miska w kolorze jesieni.", en: "Roasted pumpkin, ginger and coconut milk. A warming bowl in the colours of autumn." },
    image: "/images/pumpkin-soup.webp",
    imageAlt: { pl: "Krem z dyni z pestkami i oliwą", en: "Pumpkin soup topped with seeds and olive oil" },
    primaryCategory: "soup",
    categories: ["soup", "lunch", "dinner", "starter"],
    dietaryTags: [vegetarianTag, { id: "vegan", label: { pl: "Wegańskie", en: "Vegan" }, status: "to_review" }],
    difficulty: "easy",
    cuisine: { pl: "Kuchnia sezonowa", en: "Seasonal cooking" },
    baseServings: 4,
    times: { active: 25, cooking: 45, rest: 0, total: 70 },
    ingredients: [
      exact("pumpkin", "miąższ dyni, bez pestek i skórki", "pumpkin flesh, peeled and deseeded", "900", "g"),
      exact("onion", "cebula, obrana", "onion, peeled", "150", "g"),
      exact("garlic", "czosnek, obrany", "garlic, peeled", "10", "g"),
      exact("ginger", "świeży imbir, obrany", "fresh ginger, peeled", "15", "g"),
      exact("olive-oil", "oliwa", "olive oil", "30", "ml"),
      exact("stock", "bulion warzywny", "vegetable stock", "700", "ml", mainGroup, { pl: "Sprawdź skład i poziom soli wybranego bulionu.", en: "Check the ingredients and salt level of your chosen stock." }),
      exact("coconut-milk", "mleczko kokosowe", "coconut milk", "200", "ml"),
      exact("pumpkin-seeds", "pestki dyni", "pumpkin seeds", "20", "g", servingGroup),
      qualitative("salt", "sól", "salt"),
      qualitative("pepper", "świeżo mielony pieprz", "freshly ground black pepper"),
    ],
    steps: [
      step("roast", "Upiecz dynię", "Roast the pumpkin", "Rozgrzej piekarnik do 200 °C, góra–dół. Pokrój dynię w kawałki o podobnej wielkości, wymieszaj z połową oliwy i rozłóż na blasze. Piecz przez około 30 minut, aż będzie miękka i lekko zarumieniona.", "Heat the oven to 200 °C conventional. Cut the pumpkin into evenly sized pieces, toss with half the olive oil and spread over a baking tray. Roast for about 30 minutes, until tender and lightly browned.", 30),
      step("aromatics", "Przygotuj bazę", "Prepare the base", "W garnku rozgrzej pozostałą oliwę. Dodaj posiekaną cebulę i smaż łagodnie przez 5 minut. Dodaj posiekany czosnek i drobno starty imbir; mieszaj jeszcze przez minutę.", "Heat the remaining oil in a saucepan. Add the chopped onion and soften gently for 5 minutes. Add the chopped garlic and finely grated ginger, then stir for another minute.", 5),
      step("simmer", "Połącz składniki", "Combine the ingredients", "Dodaj pieczoną dynię i {{stock}} bulionu. Doprowadź do łagodnego wrzenia i gotuj przez 10 minut.", "Add the roasted pumpkin and {{stock}} of stock. Bring to a gentle simmer and cook for 10 minutes.", 10),
      step("blend", "Zmiksuj na krem", "Blend until smooth", "Zdejmij garnek z ognia. Dodaj {{coconut-milk}} mleczka kokosowego i zmiksuj blenderem ręcznym. Uważaj na gorące rozpryski. Dopraw solą i pieprzem; zbyt gęstą zupę rozcieńcz odrobiną wody.", "Take the pan off the heat. Add {{coconut-milk}} of coconut milk and blend with a stick blender, taking care with hot splashes. Season with salt and pepper. If the soup is too thick, add a little water."),
      step("serve", "Dodaj pestki", "Add the seeds", "Pestki dyni podpraż krótko na suchej patelni, poruszając nią, aby się nie przypaliły. Rozlej zupę do misek i posyp pestkami.", "Toast the pumpkin seeds briefly in a dry frying pan, moving them around so they do not burn. Ladle the soup into bowls and scatter over the seeds."),
    ],
    equipment: { pl: ["piekarnik", "blacha", "garnek", "blender ręczny"], en: ["oven", "baking tray", "saucepan", "stick blender"] },
    tips: { pl: ["Masa dyni dotyczy miąższu po obraniu i usunięciu pestek.", "Przy większej partii użyj dodatkowej blachy: ciasno ułożona dynia będzie się dusić."], en: ["The pumpkin weight refers to the flesh after peeling and deseeding.", "Use an extra tray for a larger batch: crowded pumpkin will steam rather than roast."] },
    storage: { pl: "Pestki przechowuj oddzielnie i dodawaj dopiero przy podaniu, aby zachowały chrupkość.", en: "Keep the seeds separate and add them just before serving so they stay crunchy." },
    provenance: demoProvenance,
    featured: false,
  },
  {
    id: "spinach-pierogi",
    slug: { pl: "pierogi-ze-szpinakiem-i-ricotta", en: "spinach-and-ricotta-pierogi" },
    title: { pl: "Pierogi ze szpinakiem i ricottą", en: "Spinach & ricotta pierogi" },
    description: { pl: "Delikatne ciasto, zielone nadzienie i masło z szałwią. Domowy rytuał wart każdej chwili.", en: "Tender dough, a green filling and sage butter. A homemade ritual worth taking your time over." },
    image: "/images/spinach-pierogi.webp",
    imageAlt: { pl: "Pierogi ze szpinakiem i ricottą z szałwią", en: "Spinach and ricotta pierogi with sage" },
    primaryCategory: "main",
    categories: ["main", "lunch", "dinner"],
    dietaryTags: [vegetarianTag],
    difficulty: "medium",
    cuisine: { pl: "Inspiracja polska", en: "Polish-inspired" },
    baseServings: 4,
    times: { active: 75, cooking: 20, rest: 20, total: 95 },
    ingredients: [
      exact("flour", "mąka pszenna", "plain flour", "350", "g", doughGroup),
      exact("water", "ciepła woda", "warm water", "190", "ml", doughGroup),
      exact("oil", "olej rzepakowy", "rapeseed oil", "15", "ml", doughGroup),
      exact("dough-salt", "sól do ciasta", "salt for the dough", "3", "g", doughGroup),
      exact("spinach", "świeży szpinak", "fresh spinach", "300", "g", fillingGroup),
      exact("ricotta", "ricotta, odsączona", "ricotta, drained", "250", "g", fillingGroup, { pl: "Sprawdź etykietę sera, jeśli przygotowujesz wersję wegetariańską.", en: "Check the cheese label if you are preparing a vegetarian version." }),
      exact("garlic", "czosnek, obrany", "garlic, peeled", "5", "g", fillingGroup),
      exact("filling-oil", "oliwa", "olive oil", "10", "ml", fillingGroup),
      qualitative("nutmeg", "gałka muszkatołowa", "nutmeg", { pl: "szczypta", en: "a pinch" }, fillingGroup),
      qualitative("salt", "sól i pieprz do nadzienia", "salt and pepper for the filling", undefined, fillingGroup),
      exact("butter", "masło", "butter", "40", "g", servingGroup),
      exact("sage", "świeża szałwia", "fresh sage", "3", "g", servingGroup),
      qualitative("dusting-flour", "mąka do podsypywania", "flour for dusting", { pl: "w razie potrzeby", en: "as needed" }, doughGroup),
      qualitative("cooking-salt", "sól do wody", "salt for the cooking water", undefined),
    ],
    steps: [
      step("dough", "Zagnieć ciasto", "Make the dough", "Wymieszaj {{flour}} mąki z {{dough-salt}} soli. Dodaj ciepłą wodę i olej rzepakowy. Wyrabiaj przez 7–8 minut, aż ciasto będzie gładkie. Przykryj i odstaw na 20 minut.", "Mix {{flour}} of flour with {{dough-salt}} of salt. Add the warm water and rapeseed oil. Knead for 7–8 minutes until smooth. Cover and rest for 20 minutes.", 20),
      step("spinach", "Przygotuj szpinak", "Prepare the spinach", "Na patelni podgrzej oliwę do nadzienia i dodaj drobno posiekany czosnek. Po chwili dodaj szpinak i mieszaj, aż zwiędnie. Ostudź, dokładnie odciśnij i posiekaj.", "Warm the filling oil in a frying pan and add the finely chopped garlic. After a moment, add the spinach and stir until wilted. Cool, squeeze out the liquid thoroughly and chop."),
      step("filling", "Połącz nadzienie", "Mix the filling", "Wymieszaj szpinak z {{ricotta}} ricotty. Dopraw gałką muszkatołową, solą i pieprzem. Nadzienie powinno być zwarte, bez zbierającego się płynu.", "Mix the spinach with {{ricotta}} of ricotta. Season with nutmeg, salt and pepper. The filling should hold together without liquid pooling around it."),
      step("shape", "Ulep pierogi", "Shape the pierogi", "Rozwałkuj ciasto partiami na grubość około 2 mm, delikatnie podsypując mąką. Wytnij kółka, nałóż nadzienie i dokładnie zlep brzegi. Niewykorzystane ciasto trzymaj pod przykryciem.", "Roll out the dough in batches to about 2 mm thick, dusting lightly with flour. Cut out circles, add the filling and seal the edges firmly. Keep unused dough covered."),
      step("cook", "Ugotuj partiami", "Cook in batches", "W szerokim garnku zagotuj osoloną wodę. Wkładaj pierogi partiami i delikatnie zamieszaj. Po wypłynięciu gotuj łagodnie przez około 3 minuty; sprawdź, czy ciasto jest ugotowane, i wyjmij łyżką cedzakową.", "Bring a wide pan of salted water to the boil. Add the pierogi in batches and stir gently. Once they float, simmer gently for about 3 minutes. Check that the dough is cooked, then lift out with a slotted spoon.", 3),
      step("sage", "Polej masłem z szałwią", "Finish with sage butter", "Rozpuść {{butter}} masła na małej patelni. Dodaj szałwię i podgrzewaj łagodnie, aż zacznie pachnieć. Polej ugotowane pierogi i podawaj.", "Melt {{butter}} of butter in a small frying pan. Add the sage and warm gently until fragrant. Spoon over the cooked pierogi and serve."),
    ],
    equipment: { pl: ["miska", "wałek", "szklanka lub wykrawacz", "szeroki garnek", "łyżka cedzakowa"], en: ["mixing bowl", "rolling pin", "glass or round cutter", "wide saucepan", "slotted spoon"] },
    tips: { pl: ["Dokładne odciśnięcie szpinaku ułatwia zlepianie pierogów.", "Nie przepełniaj nadzieniem i usuń powietrze przed sklejeniem brzegów."], en: ["Squeezing the spinach thoroughly makes the pierogi easier to seal.", "Avoid overfilling and press out trapped air before sealing the edges."] },
    storage: { pl: "Surowe pierogi do zamrożenia rozłóż osobno na tacy; po zamrożeniu przełóż do zamykanego pojemnika.", en: "To freeze uncooked pierogi, spread them out separately on a tray; once frozen, transfer to a sealed container." },
    provenance: demoProvenance,
    featured: false,
  },
  {
    id: "ricotta-pancakes",
    slug: { pl: "placuszki-z-ricotta", en: "ricotta-pancakes" },
    title: { pl: "Placuszki z ricottą", en: "Ricotta pancakes" },
    description: { pl: "Lekkie, złociste placuszki z owocami i miodem. Na powolny poranek albo małą przerwę.", en: "Light, golden pancakes with berries and honey. For a slow morning or a little afternoon pause." },
    image: "/images/ricotta-pancakes.webp",
    imageAlt: { pl: "Złociste placuszki z ricottą i owocami", en: "Golden ricotta pancakes with berries" },
    primaryCategory: "breakfast",
    categories: ["breakfast", "brunch", "afternoon", "dessert"],
    dietaryTags: [vegetarianTag],
    difficulty: "easy",
    cuisine: { pl: "Kuchnia domowa", en: "Home cooking" },
    baseServings: 4,
    times: { active: 15, cooking: 15, rest: 0, total: 30 },
    ingredients: [
      exact("ricotta", "ricotta", "ricotta", "250", "g", mainGroup, { pl: "Sprawdź etykietę sera, jeśli przygotowujesz wersję wegetariańską.", en: "Check the cheese label if you are preparing a vegetarian version." }),
      exact("eggs", "jajka średniej wielkości", "medium eggs", "2", "count", mainGroup, {
        pl: "Przy ułamku jajka roztrzep je i użyj odpowiedniej części jego rzeczywistej masy, bez skorupki.",
        en: "For a fraction of an egg, beat it and use the corresponding share of its actual weight, without the shell.",
      }),
      exact("milk", "mleko", "milk", "100", "ml"),
      exact("flour", "mąka pszenna", "plain flour", "120", "g"),
      exact("sugar", "cukier", "caster sugar", "25", "g"),
      exact("baking-powder", "proszek do pieczenia", "baking powder", "1", "tsp"),
      qualitative("salt", "sól", "salt", { pl: "szczypta", en: "a pinch" }),
      exact("frying-oil", "olej do posmarowania patelni", "oil for greasing the pan", "10", "ml", mainGroup, { pl: "Ilość do patelni, bez automatycznego skalowania; używaj cienkiej warstwy.", en: "An amount for the pan, kept fixed when scaling; use a thin coating." }, "fixed"),
      exact("berries", "owoce jagodowe", "mixed berries", "200", "g", servingGroup),
      exact("honey", "miód", "honey", "30", "g", servingGroup),
    ],
    steps: [
      step("wet", "Wymieszaj mokre składniki", "Mix the wet ingredients", "W misce roztrzep jajka z mlekiem i cukrem. Dodaj {{ricotta}} ricotty i wymieszaj; niewielkie grudki sera mogą pozostać.", "In a bowl, beat the eggs with the milk and sugar. Add {{ricotta}} of ricotta and stir; a few small lumps of cheese are fine."),
      step("dry", "Dodaj mąkę", "Add the flour", "W drugiej misce wymieszaj {{flour}} mąki, {{baking-powder}} proszku do pieczenia i szczyptę soli. Dodaj do mokrych składników i krótko wymieszaj tylko do połączenia.", "In another bowl, mix {{flour}} of flour, {{baking-powder}} of baking powder and a pinch of salt. Fold into the wet ingredients just until combined."),
      step("fry-first", "Smaż na średnim ogniu", "Cook over a medium heat", "Rozgrzej nieprzywierającą patelnię i posmaruj cienko olejem. Nakładaj niewielkie porcje ciasta, zostawiając miejsce na obracanie. Smaż pierwszą stronę przez około 2 minuty, aż brzegi zaczną się ścinać, a spód będzie złocisty.", "Heat a non-stick frying pan and brush with a thin coating of oil. Add small spoonfuls of batter, leaving room to turn them. Cook the first side for about 2 minutes, until the edges begin to set and the underside is golden.", 2),
      step("fry-second", "Obróć placuszki", "Turn the pancakes", "Obróć łopatką i smaż drugą stronę przez około 2 minuty, aż środek będzie ścięty. Jeśli placuszki rumienią się za szybko, zmniejsz ogień. Powtórz z resztą ciasta.", "Turn with a spatula and cook the other side for about 2 minutes, until the centres are set. If the pancakes brown too quickly, lower the heat. Repeat with the remaining batter.", 2),
      step("serve", "Dodaj owoce", "Finish with berries", "Podawaj ciepłe z umytymi owocami jagodowymi i miodem.", "Serve warm with washed berries and honey."),
    ],
    equipment: { pl: ["dwie miski", "trzepaczka", "patelnia nieprzywierająca", "łopatka"], en: ["two bowls", "whisk", "non-stick frying pan", "spatula"] },
    tips: { pl: ["Krótko mieszane ciasto daje delikatniejsze placuszki.", "Najpierw usmaż jeden placuszek, aby dobrać temperaturę patelni."], en: ["Brief mixing helps keep the pancakes tender.", "Cook one pancake first to find the right pan temperature."] },
    storage: { pl: "Owoce i miód dodawaj przy podaniu. Placuszki można przygotować wcześniej i podgrzać przed jedzeniem.", en: "Add the berries and honey at serving time. The pancakes can be made ahead and warmed before eating." },
    provenance: demoProvenance,
    featured: false,
  },
  {
    id: "apple-cake",
    slug: { pl: "domowa-szarlotka", en: "homemade-apple-cake" },
    title: { pl: "Domowa szarlotka", en: "Homemade apple cake" },
    description: { pl: "Kruche ciasto, soczyste jabłka i odrobina cynamonu. Ten zapach trudno pomylić z czymkolwiek.", en: "Buttery pastry, juicy apples and a little cinnamon. A familiar scent that fills the kitchen." },
    image: "/images/apple-cake.webp",
    imageAlt: { pl: "Porcja szarlotki z jabłkami i kruszonką", en: "A slice of apple cake with a crumbly topping" },
    primaryCategory: "dessert",
    categories: ["dessert", "afternoon", "snack"],
    dietaryTags: [vegetarianTag],
    difficulty: "medium",
    cuisine: { pl: "Inspiracja polska", en: "Polish-inspired" },
    baseServings: 8,
    times: { active: 50, cooking: 55, rest: 70, total: 140 },
    ingredients: [
      exact("flour", "mąka pszenna", "plain flour", "300", "g", doughGroup),
      exact("butter", "zimne masło, pokrojone", "cold butter, cubed", "150", "g", doughGroup),
      exact("sugar", "cukier", "caster sugar", "70", "g", doughGroup),
      exact("egg", "jajko średniej wielkości", "medium egg", "1", "count", doughGroup, {
        pl: "Przy ułamku jajka roztrzep je i odważ odpowiednią część jego rzeczywistej masy, bez skorupki.",
        en: "For a fraction of an egg, beat it and weigh the corresponding share of its actual weight, without the shell.",
      }),
      exact("baking-powder", "proszek do pieczenia", "baking powder", "1", "tsp", doughGroup),
      qualitative("salt", "sól", "salt", { pl: "szczypta", en: "a pinch" }, doughGroup),
      exact("apples", "jabłka, obrane i bez gniazd nasiennych", "apples, peeled and cored", "1000", "g", fillingGroup),
      exact("filling-sugar", "cukier do jabłek", "sugar for the apples", "30", "g", fillingGroup),
      exact("cinnamon", "cynamon", "ground cinnamon", "1", "tsp", fillingGroup),
      exact("lemon-juice", "sok z cytryny", "lemon juice", "15", "ml", fillingGroup),
      exact("tin-butter", "masło do formy", "butter for greasing the tin", "5", "g", doughGroup, { pl: "Stała ilość dla formy bazowej.", en: "A fixed amount for the base tin." }, "fixed"),
      qualitative("icing-sugar", "cukier puder", "icing sugar", { pl: "opcjonalnie, do oprószenia", en: "optional, for dusting" }, servingGroup),
    ],
    steps: [
      step("dough", "Przygotuj kruche ciasto", "Make the pastry", "Wymieszaj {{flour}} mąki z cukrem, proszkiem do pieczenia i solą. Dodaj zimne masło, rozetrzyj palcami do konsystencji kruszonki, następnie dodaj jajko. Krótko zagnieć tylko do połączenia.", "Mix {{flour}} of flour with the sugar, baking powder and salt. Add the cold butter and rub in with your fingertips until crumbly, then add the egg. Bring together briefly into a dough."),
      step("chill", "Schłodź", "Chill", "Podziel ciasto: dwie trzecie na spód, jedną trzecią na wierzch. Obie części zawiń i schładzaj przez 30 minut.", "Divide the dough: two thirds for the base and one third for the topping. Wrap both pieces and chill for 30 minutes.", 30),
      step("apples", "Przygotuj jabłka", "Prepare the apples", "Jabłka pokrój w cienkie plasterki. Włóż do garnka z sokiem cytrynowym i cukrem do nadzienia. Podgrzewaj, mieszając, przez około 8–10 minut, aż lekko zmiękną i odparuje nadmiar soku. Dodaj cynamon i przestudź.", "Thinly slice the apples. Put them in a saucepan with the lemon juice and filling sugar. Cook, stirring, for about 8–10 minutes, until slightly softened and the excess juice has evaporated. Stir in the cinnamon and let cool.", 10),
      step("assemble", "Ułóż w formie", "Assemble in the tin", "Rozgrzej piekarnik do 180 °C, góra–dół. Bazowa partia jest przeznaczona do tortownicy o średnicy 20 cm. Wyłóż dno papierem i posmaruj boki masłem do formy. Większą częścią ciasta wylep spód i niewysoki rant. Nałóż jabłka, a na wierzch zetrzyj lub pokrusz pozostałe ciasto.", "Heat the oven to 180 °C conventional. The base batch is for a 20 cm round cake tin. Line the base with baking paper and grease the sides with the tin butter. Press the larger piece of pastry over the base and a little way up the sides. Add the apples, then grate or crumble the remaining pastry over them."),
      step("bake", "Upiecz na złoto", "Bake until golden", "Piecz na środkowej półce przez około 40–45 minut, aż wierzch i brzegi będą złociste, a spód dopieczony. Czas dotyczy partii bazowej i może zależeć od formy oraz piekarnika.", "Bake on the middle shelf for about 40–45 minutes, until the top and edges are golden and the base is cooked through. This timing is for the base batch and may vary with the tin and oven.", 40),
      step("serve", "Przestudź przed krojeniem", "Cool before slicing", "Pozostaw w formie do przestudzenia, aby nadzienie się ustabilizowało. Jeśli chcesz, oprósz cukrem pudrem i pokrój na porcje.", "Leave in the tin to cool so the filling can settle. Dust with icing sugar if you like, then cut into portions."),
    ],
    equipment: { pl: ["tortownica 20 cm dla partii bazowej", "garnek", "tarka", "papier do pieczenia"], en: ["20 cm round cake tin for the base batch", "saucepan", "grater", "baking paper"] },
    tips: { pl: ["Masa jabłek dotyczy owoców po obraniu i usunięciu gniazd nasiennych.", "Zagnieć ciasto krótko, aby nie stało się twarde.", "Chłodzenie nadzienia zapobiega rozmiękaniu surowego ciasta."], en: ["The apple weight refers to the fruit after peeling and coring.", "Handle the pastry briefly so it stays tender.", "Cooling the filling helps prevent the raw pastry becoming soft."] },
    storage: { pl: "Przed przykryciem pozwól ciastu całkowicie wystygnąć, aby para nie rozmiękczyła wierzchu.", en: "Let the cake cool completely before covering it so trapped steam does not soften the topping." },
    scalingNote: { pl: "Kalkulator przelicza składniki, ale nie dobiera formy ani czasu pieczenia. Partia bazowa: 8 porcji, forma 20 cm. Zmiana wielkości wypieku wymaga dopasowania formy i czasu pieczenia.", en: "The calculator adjusts ingredients, but does not choose a tin or baking time. Base batch: 8 portions, 20 cm tin. A different batch size needs a suitable tin and baking time." },
    provenance: demoProvenance,
    featured: false,
  },
  {
    id: "beetroot-salad",
    slug: { pl: "salatka-z-pieczonymi-burakami-i-feta", en: "roasted-beetroot-and-feta-salad" },
    title: { pl: "Pieczone buraki i feta", en: "Roasted beetroot & feta" },
    description: { pl: "Słodkie buraki, słona feta i orzechy. Kolorowa sałatka z prostym miodowym dressingiem.", en: "Sweet beetroot, salty feta and walnuts. A colourful salad with a simple honey dressing." },
    image: "/images/beetroot-salad.webp",
    imageAlt: { pl: "Sałatka z pieczonych buraków, fety i rukoli", en: "Roasted beetroot, feta and rocket salad" },
    primaryCategory: "lunch",
    categories: ["lunch", "starter", "dinner", "brunch"],
    dietaryTags: [vegetarianTag],
    difficulty: "easy",
    cuisine: { pl: "Inspiracja śródziemnomorska", en: "Mediterranean-inspired" },
    baseServings: 4,
    times: { active: 15, cooking: 45, rest: 10, total: 70 },
    ingredients: [
      exact("beetroot", "buraki, obrane", "beetroot, peeled", "700", "g"),
      exact("roasting-oil", "oliwa do pieczenia", "olive oil for roasting", "15", "ml"),
      exact("rocket", "rukola", "rocket", "80", "g"),
      exact("feta", "feta", "feta", "150", "g", mainGroup, { pl: "Dla wersji wegetariańskiej wybierz fetę z podpuszczką mikrobiologiczną. W podstawowej wersji użyj sera z podpuszczką mikrobiologiczną lub roślinną.", en: "For a vegetarian version, choose feta made with vegetarian rennet. For the base recipe, use cheese made with microbial or vegetarian rennet." }),
      exact("walnuts", "orzechy włoskie", "walnuts", "40", "g"),
      exact("dressing-oil", "oliwa do dressingu", "olive oil for the dressing", "30", "ml", { pl: "Dressing", en: "Dressing" }),
      exact("vinegar", "ocet balsamiczny", "balsamic vinegar", "15", "ml", { pl: "Dressing", en: "Dressing" }),
      exact("honey", "miód", "honey", "10", "g", { pl: "Dressing", en: "Dressing" }),
      qualitative("salt", "sól", "salt"),
      qualitative("pepper", "świeżo mielony pieprz", "freshly ground black pepper"),
    ],
    steps: [
      step("roast", "Upiecz buraki", "Roast the beetroot", "Rozgrzej piekarnik do 200 °C, góra–dół. Pokrój buraki w podobnej wielkości łódeczki. Wymieszaj z oliwą do pieczenia, solą i pieprzem. Rozłóż na blasze i piecz przez około 40–45 minut, obracając w połowie. Powinny być miękkie po nakłuciu.", "Heat the oven to 200 °C conventional. Cut the beetroot into evenly sized wedges. Toss with the roasting oil, salt and pepper. Spread over a baking tray and roast for about 40–45 minutes, turning halfway through, until tender when pierced.", 40),
      step("cool", "Przestudź i przygotuj dodatki", "Cool and prepare the toppings", "Pozostaw buraki do przestudzenia przez około 10 minut. Umyj i osusz rukolę. Orzechy podpraż krótko na suchej patelni i grubo posiekaj.", "Leave the beetroot to cool for about 10 minutes. Wash and dry the rocket. Briefly toast the walnuts in a dry frying pan and roughly chop them.", 10),
      step("dressing", "Wymieszaj dressing", "Mix the dressing", "W małym słoiku połącz {{dressing-oil}} oliwy, {{vinegar}} octu balsamicznego i {{honey}} miodu. Zamknij i wstrząśnij. Dopraw pieprzem i ewentualnie odrobiną soli, pamiętając o słonej fecie.", "Combine {{dressing-oil}} of olive oil, {{vinegar}} of balsamic vinegar and {{honey}} of honey in a small jar. Close and shake. Season with pepper and a little salt if needed, remembering that the feta is salty."),
      step("serve", "Ułóż sałatkę", "Assemble the salad", "Rozłóż rukolę i buraki na półmisku. Dodaj pokruszoną fetę i orzechy. Polej dressingiem tuż przed podaniem.", "Arrange the rocket and beetroot on a platter. Add the crumbled feta and walnuts. Drizzle with the dressing just before serving."),
    ],
    equipment: { pl: ["piekarnik", "blacha", "patelnia", "mały słoik", "półmisek"], en: ["oven", "baking tray", "frying pan", "small jar", "serving platter"] },
    tips: { pl: ["Buraki możesz upiec wcześniej — składanie sałatki zajmie wtedy tylko kilka minut.", "Rukolę i dressing dodaj na końcu, aby liście zachowały świeżość."], en: ["Roast the beetroot ahead so assembling the salad takes just a few minutes.", "Add the rocket and dressing at the end to keep the leaves fresh."] },
    storage: { pl: "Buraki, liście i dressing przechowuj oddzielnie. Połącz je dopiero przed podaniem.", en: "Keep the beetroot, leaves and dressing separate. Combine them just before serving." },
    provenance: demoProvenance,
    featured: false,
  },
];

export function findRecipe(locale: Locale, slug: string): Recipe | undefined {
  return recipes.find((recipe) => recipe.slug[locale] === slug);
}

export function getRecipeHref(recipe: Pick<Recipe, "slug">, locale: Locale): string {
  return `/${locale}/recipes/${recipe.slug[locale]}`;
}
