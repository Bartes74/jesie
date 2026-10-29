import type { Ingredient, Recipe } from './recipes';
import { normalizeIngredientVerificationName } from './ingredient-verification';

export const recipeDietIds = ['meat', 'vegetarian', 'vegan'] as const;
export type RecipeDietId = typeof recipeDietIds[number];
/** Server-verified exact ingredient aliases, keyed with normalizeIngredientVerificationName. */
export type VerifiedIngredientDictionary = ReadonlyMap<string, RecipeDietId>;

export const recipeDiets = [
  { id: 'meat', label: { pl: 'Mięsne', en: 'Meat & fish' } },
  { id: 'vegetarian', label: { pl: 'Wegetariańskie', en: 'Vegetarian' } },
  { id: 'vegan', label: { pl: 'Wegańskie', en: 'Vegan' } },
] as const satisfies readonly { id: RecipeDietId; label: { pl: string; en: string } }[];

/** Additive product-selection notes; they change dietary suitability, not photographic form. */
export const recipeDietBaseNotes = {
  cheese: { pl: 'W podstawowej wersji użyj sera z podpuszczką mikrobiologiczną lub roślinną.', en: 'For the base recipe, use cheese made with microbial or vegetarian rennet.' },
  gnocchi: { pl: 'W podstawowej wersji wybierz gnocchi odpowiednie dla wegetarian, bez mięsa, ryb, żelatyny i tłuszczów poubojowych.', en: 'For the base recipe, use vegetarian gnocchi without meat, fish, gelatin or slaughter-derived fats.' },
  margarine: { pl: 'W podstawowej wersji wybierz margarynę odpowiednią dla wegetarian, na tłuszczach roślinnych i bez składników poubojowych.', en: 'For the base recipe, use vegetarian margarine made with plant fats and without slaughter-derived ingredients.' },
} as const;

type DietRecipe = Pick<Recipe, 'ingredients'> & { diet?: RecipeDietId };
export type RecipeDietEvidence = { ingredientId: string; diet: RecipeDietId; reason: string };
export type RecipeDietUncertaintyKind = 'unrecognised-ingredient' | 'ambiguous-composition' | 'uncertain-rennet';
export type RecipeDietUncertainty = { ingredientId: string; kind: RecipeDietUncertaintyKind; reason: string };
export type RecipeDietInspection = {
  diet: RecipeDietId;
  /** null means that the ingredient list cannot support an exact classification yet. */
  inferredDiet: RecipeDietId | null;
  evidence: RecipeDietEvidence[];
  uncertainIngredients: RecipeDietUncertainty[];
  issues: { field: string; message: string }[];
};

function normalise(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ł/g, 'l')
    .replace(/[’‘]/g, "'").replace(/[^a-z0-9%\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const animalFlesh = /\b(?:meat|meatballs?|beef|pork|veal|lamb|mutton|venison|rabbit|chicken|turkey|duck|goose|geese|poultry|bacon|ham|prosciutto|pancetta|salami|chorizo|salsiccia|sausage|lard|tallow|suet|dripping|gelatine?|collagen|isinglass|carmine|cochineal|shellac|fish|salmon|tuna|cod|haddock|herring|sardines?|anchov(?:y|ies)|trout|mackerel|sea bass|seabass|seabream|sea bream|shrimp|prawns?|crab|lobster|crayfish|mussels?|clams?|oysters?|scallops?|squid|octopus|cuttlefish|caviar|bonito|katsuobushi|surimi|mieso|miesa|miesem|miesie|wolow\w*|wieprzow\w*|cielec\w*|jagniec\w*|baranin\w*|dziczyzn\w*|krolik\w*|kurczak\w*|indy[ck]\w*|kaczk\w*|gesina|drobi\w*|boczek|boczk\w*|szynk\w*|kielbas\w*|smalec|smalcu|smalcem|loj|zelatyn\w*|kolagen\w*|ryb\w*|losos\w*|tunczyk\w*|dorsz\w*|sledz\w*|sardyn\w*|anchois|pstrag\w*|makrel\w*|labraks\w*|dorad\w*|krewet\w*|krab\w*|homar\w*|malz\w*|ostryg\w*|przegrzeb\w*|kalmar\w*|osmiornic\w*|kawior\w*|karmin\w*|koszenil\w*)\b/;
const animalRennet = /\b(?:animal|calf|traditional)\s+(?:rennet|enzymes?)\b|\b(?:podpuszcz\w*\s+(?:zwierzec\w*|cielec\w*)|pepsin\w*|pepsyn\w*)\b/;
const traditionalHardCheese = /\b(?:parmesan|parmezan\w*|parmigiano(?: reggiano)?|grana padano|pecorino(?: romano)?|roquefort)\b/;
const dairyAndEggs = /\b(?:milk|butter|ghee|cream|creme fraiche|shortbread|yoghurt|yogurt|kefir|buttermilk|whey|casein|lactose|eggs?|yolks?|egg whites?|honey|royal jelly|beeswax|mayonnaise|mayo|mleko|mleka|mleku|mlekiem|mleczk\w*|maslo|masla|maslem|masle|maslan\w*|smietan\w*|jogurt\w*|kefir\w*|maslank\w*|serwatk\w*|kazein\w*|laktoz\w*|jaj\w*|zolt\w*|bialk\w*|miod\w*|majonez\w*|wosk pszczeli)\b/;
// Ready-made doughs and crackers usually are plant-based, but some brands add butter, milk or eggs.
// Without a label they count as vegetarian: never meat, never certified vegan.
const bakedDough = /\b(?:filo|phyllo|fillo|yufka|kataifi|pretzels?|precel\w*|papdi|papri|sev)\b/;
const cheese = /\b(?:cheese|cheddar|burrata|feta|mozzarella|halloumi|gouda|edam|camembert|brie|gorgonzola|gruyere|emmental|manchego|raclette|ser|sera|serem|sery|serow\w*|koz(?:i|iego|im))\b/;
const acidCheese = /\b(?:ricotta|paneer|cottage cheese|cream cheese|mascarpone|twarog\w*|serek smietankowy)\b/;
const vegetarianRennet = /\b(?:microbial|vegetarian|vegetable|plant|thistle)\s+rennet\b|\b(?:podpuszcz\w*\s+(?:mikrobiologiczn\w*|roslinn\w*|wegetarians\w*))\b|\b(?:vegetarian cheese|ser\w* wegetarians\w*)\b/;
const conditionalRennet = /\b(?:if|for a vegetarian|for the vegetarian|for a vegan|dla wersji|jezeli|jesli|opcjonaln\w*|optional\w*|alternativ\w*|alternatyw\w*|zamien\w*|zastap\w*|moz(?:esz|na))\b/;

// Strip only named plant replacements. A note suggesting a replacement never changes the base ingredient.
function withoutPlantReplacements(name: string): { text: string; plantReplacement: boolean } {
  const patterns = [
    /\b(?:coconut|oat|soya?|almond|rice|cashew|hemp|pea|hazelnut|plant[- ]based|plant|vegan)\s+(?:milk|cream|butter|cheese|yoghurt|yogurt|mayonnaise|mayo|eggs?|honey)\b/g,
    /\b(?:vegan|plant[- ]based)\s+(?:(?:minced|smoked)\s+)?(?:meat|chicken|beef|pork|turkey|duck|sausage(?:s)?|bacon|ham|fish|mince)\b/g,
    /\b(?:wegansk\w*|roslinn\w*)\s+(?:(?:mielon\w*|wedzon\w*)\s+)?(?:mieso|kurczak\w*|kielbas\w*|boczek|ryb\w*|szynk\w*)\b/g,
    /\b(?:mieso|kurczak\w*|kielbas\w*|boczek|ryb\w*|szynk\w*)\s+(?:wegansk\w*|roslinn\w*)\b/g,
    /\b(?:vegan|plant[- ]based)\s+(?:parmesan|parmigiano reggiano|cheddar|feta|mozzarella|burrata)(?:[- ]style)?(?:\s+cheese)?\b/g,
    /\b(?:wegansk\w*|roslinn\w*)\s+(?:parmezan\w*|cheddar|feta|mozzarella|burrata)\b/g,
    /\b(?:peanut|almond|cashew|apple|cocoa|shea|sunflower seed)\s+butter\b/g,
    /\b(?:milk of lime|milk thistle|eggplant|eggplants)\b/g,
    /\b(?:(?:king )?oyster mushrooms?|chicken of the woods|hen of the woods|turkey tail mushrooms?|milk cap mushrooms?|butter beans?|lamb'?s lettuce|beef tomatoes)\b/g,
    /\b(?:mleko|mleka|mleku|mlekiem|mleczko|mleczka|mleczku|mleczkiem|smietank\w*|jogurt\w*|maslo|masla|maslem|masle|ser|sera|majonez\w*)\s+(?:(?:pelnotlust\w*|nieslodzon\w*|bez cukru)\s+)*(?:kokosow\w*|owsian\w*|sojow\w*|migdalow\w*|ryzow\w*|roslinn\w*|wegansk\w*|orzechow\w*|jablkow\w*|kakaow\w*)\b/g,
    /\b(?:wegansk\w*|roslinn\w*)\s+(?:maslo|mleko|mleczko|smietank\w*|ser|majonez\w*|jaj\w*)\b/g,
    /\b(?:bialk\w*\s+(?:roslinn\w*|groch\w*|sojow\w*|ryzow\w*)|(?:pea|soy|soya|rice|plant) protein)\b/g,
  ];
  let text = name;
  for (const pattern of patterns) text = text.replace(pattern, ' plantreplacement ');
  return { text, plantReplacement: text !== name };
}

const knownPlant = /\b(?:plantreplacement|water|salt|pepper(?:corns)?|oil|vinegar|sugar|flour|starch|baking powder|baking soda|sodium bicarbonate|yeast|breadcrumbs|bread|baguette|focaccia|sourdough|pasta|penne|tagliatelle|macaroni|orzo|lasagne|rice|barley|oats?|quinoa|buckwheat|millet|couscous|bulgur|semolina|tofu|tempeh|seitan|soy sauce|soya sauce|miso|mirin|mustard|tomato(?:es)?|passata|potato(?:es)?|sweet potato(?:es)?|carrots?|onions?|shallots?|garlic|ginger|cabbage|broccoli|cauliflower|spinach|kale|rocket|lettuce|celery|celeriac|parsnip|beetroot|beets?|pumpkin|squash|courgette|zucchini|cucumber(?:s)?|peas?|beans?|chickpeas?|lentils?|mushrooms?|shiitake|porcini|corn|sweetcorn|chilli(?:es)?|chili|habanero(?:s)?|jalapeno(?:s)?|paprika|cayenne|herbs?|basil|parsley|dill|thyme|rosemary|oregano|marjoram|mint|coriander|cilantro|sage|bay|allspice|cumin|turmeric|cinnamon|nutmeg|cloves?|cardamom|saffron|sumac|sesame|poppy|mustard seeds?|walnuts?|pistachios?|almonds?|hazelnuts?|peanuts?|cashews?|pecans?|seeds?|coconut|apples?|pears?|plums?|peaches?|apricots?|cherries|berries|redcurrants?|blackcurrants?|strawberries|raspberries|blueberries|cranberries|raisins?|dates?|figs?|lemon(?:s)?|limes?|oranges?|pomegranate|molasses|maple|agave|cocoa|cacao|coffee|tea|vanilla|spirits?|cognac|brandy|sriracha|pul biber|taco seasoning|spice blend|shichimi|togarashi|woda|wody|wodzie|sol|soli|pieprz\w*|oliw\w*|olej\w*|ocet|octu|cukier|cukru|cukrem|mak\w*|skrobi\w*|proszek do pieczenia|soda|drozdz\w*|bulka tarta|bulki tartej|pieczyw\w*|chleb\w*|bagiet\w*|ryz\w*|kasz\w*|peczak\w*|platki owsiane|gorczyc\w*|musztard\w*|pomidor\w*|ziemniak\w*|batat\w*|marchew\w*|cebul\w*|szalot\w*|czosn\w*|czosnek|imbi\w*|kapust\w*|brokul\w*|kalafior\w*|szpinak\w*|jarmuz\w*|rukol\w*|salat\w*|seler\w*|pietrusz\w*|pasternak\w*|burak\w*|dyni\w*|ogor\w*|grosz\w*|fasol\w*|ciecierzyc\w*|soczewic\w*|pieczark\w*|grzyb\w*|kukurydz\w*|papry\w*|ziol\w*|bazyli\w*|koper\w*|tymi\w*|rozmary\w*|oregan\w*|majeran\w*|miet\w*|kolendr\w*|szalwi\w*|laurow\w*|ziele angielskie|kmin\w*|kumin\w*|kurkum\w*|cynamon\w*|galka muszkatolowa|galki muszkatolowej|sezam\w*|orzech\w*|pistac\w*|migdal\w*|pest\w*|kokos\w*|jabl\w*|grusz\w*|sliw\w*|brzoskw\w*|wisn\w*|porzecz\w*|cytryn\w*|limon\w*|pomarancz\w*|granat\w*|syrop klonowy|kakao|kawa|kawy|herbat\w*|wanili\w*|spirytus\w*|koniak\w*)\b/;
// Keep additions grouped by the actual plant rather than recipe-specific IDs.
// Names may include a preparation adjective or an inflected Polish form. This
// vocabulary is checked only after animal evidence and compound formulations;
// a recognised plant word must never certify an unspecified sauce or stock.
const plantVocabulary = {
  nutsAndSeeds: /\b(?:orzeszek|orzeszk(?:a|owi|iem|u|i|ow|om|ami|ach))\s+ziemn(?:y|ego|emu|ym|e|ych|ymi)\b/,
  vegetables: /\b(?:aubergines?|eggplants?|leeks?|fennel|kohlrabi|artichokes?|asparagus|radish(?:es)?|turnips?|swedes?|rutabagas?|okra|pak[- ]?choi|bok[- ]?choy|chard|sorrel|rhubarb|watercress|cress|horseradish|avocados?|olives?|capers?|brussels sprouts|courgettes?|zucchinis?|chicory|endives?|witloof|baklazan\w*|por(?:a|y|ow|em|ze)?|fenkul\w*|kalarep\w*|karczoch\w*|szparag\w*|rzodkiew\w*|rzep(?:a|y|ie|e)?|brukiew|brukwi\w*|botwin\w*|bocwin\w*|szczaw\w*|rabarbar\w*|rukiew|rukwi\w*|rzezuch\w*|chrzan\w*|awokado|kapar\w*|bruksel\w*|cukini\w*|cykori\w*|endywi\w*)\b/,
  fruit: /\b(?:bananas?|grapes?|melons?|watermelons?|kiwifruit|kiwis?|mango(?:es|s)?|pineapples?|nectarines?|gooseberries|blackberries|tangerines?|mandarins?|grapefruits?|banan\w*|winogron\w*|melon\w*|arbuz\w*|kiwi|mango|ananas\w*|nektaryn\w*|agrest\w*|jezyn\w*|truskawk\w*|malin\w*|jagod\w*|czeresni\w*|morel\w*|daktyl\w*|fig\w*|mandaryn\w*|grejpfrut\w*)\b/,
  herbsAndSpices: /\b(?:fenugreek|utskho[- ]suneli|utsho[- ]suneli|uccho[- ]suneli|marigolds?|tagetes|maritsa|chives?|tarragon|chervil|(?:summer|winter) savou?ry|lemongrass|caraway|nigella|juniper|lovage|anise|aniseed|mace|tamarind|galangal|kozieradk\w*|aksamitk\w*|szczypior\w*|estragon\w*|trybul\w*|czabr\w*|trawa cytrynowa|anyz\w*|czarnuszk\w*|jalow\w*|lubczyk\w*|szafran\w*|tamarynd\w*|galang\w*)\b/,
  spiceBlends: /\b(?:za'?atar|zatar|chaat masala|garam masala|ras el hanout|baharat|dukkah|duqqa)\b/,
  seaVegetables: /\b(?:nori|seaweed|algae|wakame|kombu|kelp|dulse|spirulina|chlorella|agar(?:[- ]agar)?|wodorost\w*|glon\w*)\b/,
} as const;
const recognisedPlantAlias = (name: string) => Object.values(plantVocabulary).some(pattern => pattern.test(name));
const ambiguousCompound = /\b(?:stock|broth|bouillon|bulion\w*|wywar\w*|dashi|worcestershire|wine|wino|wina|winem|margarine|margaryn\w*|gnocchi|tortellini|ravioli|pesto|kimchi|curry paste|pasta curry|sauce|sos|sosu|paste|pasta)\b/;
const knownPlantCompound = /\b(?:vegetable|vegan|plant[- ]based) (?:stock|broth|bouillon)|\bbulion\w* warzywn\w*|\bwywar\w* warzywn\w*|\b(?:soy|soya|tomato|chilli|chili|pepper|miso) (?:sauce|paste)|\bsos sojowy|\bkoncentrat pomidorowy|\bpasta (?:miso|paprykow\w*)\b/;
const explicitVegan = /\b(?:vegan|wegansk\w*)\b/;

function inspectIngredientStatic(ingredient: Ingredient): { evidence?: RecipeDietEvidence; uncertainty?: RecipeDietUncertainty } {
  const names = [normalise(ingredient.name.pl), normalise(ingredient.name.en)];
  const name = names.join(' ');
  const noteSentences = [ingredient.note?.pl ?? '', ingredient.note?.en ?? ''].flatMap(value => value.split(/[.!?;]/).map(normalise));
  const replacedNames = names.map(withoutPlantReplacements);
  const replacement = { text: replacedNames.map(item => item.text).join(' '), plantReplacement: replacedNames.some(item => item.plantReplacement) };
  const text = replacement.text;
  const evidence = (diet: RecipeDietId, reason: string) => ({ evidence: { ingredientId: ingredient.id, diet, reason } });
  const uncertainty = (kind: RecipeDietUncertaintyKind, reason: string) => ({ uncertainty: { ingredientId: ingredient.id, kind, reason } });
  const compositionNotes = noteSentences.filter(note => !conditionalRennet.test(note)
    && !/\b(?:without|not|no|bez|nie|may contain|moze zawierac)\b/.test(note)
    && /\b(?:contains|made with|includes|zawiera|z dodatkiem|na bazie|z podpuszczka)\b/.test(note));
  // Only the directly named replacement is removed; any real meat alongside it remains evidence.
  if (animalRennet.test(name) || animalFlesh.test(text)
    || compositionNotes.some(note => animalRennet.test(note) || animalFlesh.test(note))) return evidence('meat', 'Contains meat, fish, seafood or a slaughter-derived ingredient.');
  const certifiedRennet = vegetarianRennet.test(name) || noteSentences.some(note => vegetarianRennet.test(note) && !conditionalRennet.test(note));
  const requiredDietNotes = noteSentences.filter(note => /\b(?:use|choose|select|wybierz|uzyj)\b/.test(note) && !conditionalRennet.test(note));
  const certifiedVegetarianCompound = requiredDietNotes.some(note => /\b(?:vegetarians?|wegetarian\w*)\b/.test(note)
    && !/\b(?:not vegetarian|not suitable for vegetarians|nie jest wegetarians\w*)\b/.test(note));
  const certifiedVeganCompound = requiredDietNotes.some(note => explicitVegan.test(note)
    && !/\b(?:not vegan|not suitable for vegans|nie jest wegansk\w*)\b/.test(note));
  if (traditionalHardCheese.test(text) && !/\b(?:style|typu|like)\b/.test(text)) {
    return evidence('meat', 'Traditional Parmesan/Parmigiano/Grana/Pecorino/Roquefort uses animal rennet.');
  }
  if (acidCheese.test(text)) return evidence('vegetarian', 'Contains dairy cheese.');
  if (cheese.test(text) || traditionalHardCheese.test(text)) {
    if (!certifiedRennet) return uncertainty('uncertain-rennet', 'Cheese must specify vegetarian or microbial rennet in the base ingredient, rather than only as an optional substitution.');
    return evidence('vegetarian', 'The base cheese specifies its dietary suitability.');
  }
  if (dairyAndEggs.test(text) || compositionNotes.some(note => dairyAndEggs.test(withoutPlantReplacements(note).text))) return evidence('vegetarian', 'Contains dairy, eggs or honey.');
  if (bakedDough.test(text) && !explicitVegan.test(name)) return evidence('vegetarian', 'Ready-made dough product that may contain dairy or eggs.');
  if (replacement.plantReplacement || explicitVegan.test(name)) return evidence('vegan', 'An explicitly named plant replacement is used in the base recipe.');
  if (ambiguousCompound.test(name) && (certifiedVegetarianCompound || certifiedVeganCompound)) {
    return evidence(certifiedVeganCompound ? 'vegan' : 'vegetarian', 'The base ingredient note explicitly requires a product suitable for this diet.');
  }
  if (ambiguousCompound.test(name) && !knownPlantCompound.test(name)
    && !/\b(?:vinegar|ocet|octu|pasta cooking water|pasta or dumpling cooking water|woda z gotowania makaronu|dried (?:penne|tagliatelle|lasagne)|short pasta|makaron)\b/.test(name)) {
    return uncertainty('ambiguous-composition', 'A compound ingredient has an unspecified composition; specify its animal-free formulation for a vegetarian or vegan recipe.');
  }
  if (knownPlant.test(name) || recognisedPlantAlias(name) || knownPlantCompound.test(name) || /\b(?:curry powder|curry w proszku|przyprawa curry)\b/.test(name)) return evidence('vegan', 'Recognised plant or mineral ingredient.');
  return uncertainty('unrecognised-ingredient', 'Unrecognised ingredient: its dietary suitability needs an explicit review or a more precise ingredient name.');
}

function inspectIngredient(ingredient: Ingredient, verifiedAliases?: VerifiedIngredientDictionary) {
  const inspected = inspectIngredientStatic(ingredient);
  const diets = [ingredient.name.pl, ingredient.name.en].flatMap(name => {
    const diet = verifiedAliases?.get(normalizeIngredientVerificationName(name));
    return diet ? [diet] : [];
  });
  if (!diets.length) return inspected;
  // A plain-food dictionary cannot certify the formulation of a sauce or the
  // rennet used by a cheese, even when a returned alias happens to match it.
  if (inspected.uncertainty && inspected.uncertainty.kind !== 'unrecognised-ingredient') return inspected;
  const known = inspected.evidence?.diet;
  const diet: RecipeDietId = known === 'meat' || diets.includes('meat') ? 'meat'
    : known === 'vegetarian' || diets.includes('vegetarian') ? 'vegetarian' : 'vegan';
  if (known === diet) return inspected;
  return { evidence: { ingredientId: ingredient.id, diet, reason: 'Exact ingredient identity and dietary category verified against source evidence.' } };
}

/** Only unknown names need a dictionary read. Inspect translations independently
 * and without notes so a dairy note cannot hide an unfamiliar animal ingredient. */
export function unrecognisedRecipeIngredientNames(ingredients: readonly Ingredient[]): string[] {
  return [...new Set(ingredients.flatMap(ingredient => [ingredient.name.pl, ingredient.name.en].filter(name => name.trim()
    && inspectIngredientStatic({ ...ingredient, name: { pl: name, en: name }, note: undefined }).uncertainty?.kind === 'unrecognised-ingredient')))];
}

/** Checks the actual base ingredients only. Titles, old dietaryTags and substitutions are not evidence. */
export function inspectRecipeDiet(recipe: DietRecipe, verifiedAliases?: VerifiedIngredientDictionary): RecipeDietInspection {
  const evidence: RecipeDietEvidence[] = [];
  const uncertainIngredients: RecipeDietUncertainty[] = [];
  for (const ingredient of recipe.ingredients) {
    const result = inspectIngredient(ingredient, verifiedAliases);
    if (result.evidence) evidence.push(result.evidence);
    if (result.uncertainty) uncertainIngredients.push(result.uncertainty);
  }
  const clearMeat = evidence.some(item => item.diet === 'meat');
  const clearVegetarian = evidence.some(item => item.diet === 'vegetarian');
  const inferredDiet = clearMeat ? 'meat' : uncertainIngredients.length || !recipe.ingredients.length ? null : clearVegetarian ? 'vegetarian' : 'vegan';
  const issues: RecipeDietInspection['issues'] = [];
  if (recipe.diet === 'vegan' && (clearMeat || clearVegetarian)) issues.push({ field: 'diet', message: 'A vegan recipe cannot contain meat, fish, animal rennet, dairy, eggs or honey in its base ingredients.' });
  if (recipe.diet === 'vegetarian' && clearMeat) issues.push({ field: 'diet', message: 'A vegetarian recipe cannot contain meat, fish, seafood, gelatin or animal rennet in its base ingredients.' });
  if (recipe.diet && inferredDiet && recipe.diet !== inferredDiet) issues.push({ field: 'diet', message: `The ingredient list supports category ${inferredDiet}; use the most specific category for the base recipe.` });
  const declaredIsUnsafe = (recipe.diet === 'vegan' && (clearMeat || clearVegetarian)) || (recipe.diet === 'vegetarian' && clearMeat);
  const diet = declaredIsUnsafe ? (clearMeat ? 'meat' : 'vegetarian') : recipe.diet ?? inferredDiet ?? 'meat';
  return { diet, inferredDiet, evidence, uncertainIngredients, issues };
}

/** Reviewed explicit categories survive legacy ingredients; known contradictions never do. */
export function getRecipeDiet(recipe: DietRecipe, verifiedAliases?: VerifiedIngredientDictionary): RecipeDietId {
  return inspectRecipeDiet(recipe, verifiedAliases).diet;
}

/** Reclassifies from ingredients, ignoring any stored category that may have become stale. */
export function classifyRecipeDiet(recipe: Pick<Recipe, 'ingredients'>, verifiedAliases?: VerifiedIngredientDictionary): RecipeDietId {
  return inspectRecipeDiet({ ingredients: recipe.ingredients }, verifiedAliases).diet;
}
