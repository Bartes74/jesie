import assert from 'node:assert/strict';
import test from 'node:test';
import { heroPresentationIssue, heroPresentationProfile, isGlassHeroPresentation, resolveHeroPresentation, resolveHeroPresentationForBrief, suggestHeroPresentation } from './hero-presentation';
import { recipes, type Localised, type Recipe, type RecipeStep } from './recipes';

const localised = (pl: string, en: string): Localised => ({ pl, en });
const step = (id: string, title: Localised, text: Localised): RecipeStep => ({ id, title, text });
function recipe(title: Localised, description: Localised, steps: RecipeStep[]): Recipe {
  return { ...structuredClone(recipes[0]), title, description, steps };
}

// Small real method excerpts keep the regressions independent of private verification files.
const sauce = recipe(
  localised('Słoneczny sos paprykowy z gruszką', 'Sunny yellow pepper and pear sauce'),
  localised('Gładki sos z żółtej papryki i słodkiej gruszki, z pomarańczą.', 'A smooth yellow pepper and sweet pear sauce with orange.'),
  [
    step('simmer-peppers-and-pear', localised('Duś do pełnej miękkości', 'Simmer until completely soft'), localised('Dodaj paprykę, gruszkę i zachowany sok pomarańczowy. Duś do miękkości.', 'Add the peppers, pear and reserved orange juice. Simmer until soft.')),
    step('blend-sauce', localised('Zmiksuj na gładko', 'Blend until smooth'), localised('Miksuj przez około minutę, aż znikną wyczuwalne kawałki.', 'Blend for about a minute until no discernible pieces remain.')),
    step('adjust-consistency-and-serve', localised('Dopasuj konsystencję i podaj', 'Adjust the consistency and serve'), localised('Gotowy sos powinien być aksamitny, oblepiać tył łyżki i spływać z niej szeroką strużką. Podawaj od razu.', 'The finished sauce should be velvety, coat the back of a spoon and pour from it in a broad ribbon. Serve straight away.')),
  ],
);
sauce.storage = localised('Sam fakt wlania gorącego sosu do wyparzonego słoika nie zapewnia trwałości.', 'Filling a scalded jar with hot sauce does not make it suitable for storage.');

const cowboyCandy = recipe(
  localised('Brzoskwiniowe cowboy candy', 'Peach cowboy candy'),
  localised('Słodko-pikantne jalapeño z jędrnymi kawałkami brzoskwiń w octowym syropie.', 'Sweet-hot jalapeños and tender pieces of peach that hold their shape, in a tangy syrup.'),
  [
    step('prepare_jars', localised('Przygotuj słoiki', 'Prepare the jars'), localised('Umyj słoiki i zakrętki. Trzymaj słoiki w cieple do napełnienia.', 'Wash the jars and lids. Keep the jars warm until filling.')),
    step('cook_peaches', localised('Krótko podgotuj brzoskwinie', 'Briefly cook the peaches'), localised('Kostki powinny zachować kształt i wyraźne krawędzie, nie rozpadać się na dżem.', 'The cubes should remain distinct, with their edges intact, rather than breaking down into jam.')),
    step('reduce_syrup', localised('Przełóż owoce i zredukuj syrop', 'Transfer the fruit and reduce the syrup'), localised('Łyżką cedzakową przełóż papryczki i brzoskwinie do ciepłych słoików, bez mocnego ubijania.', 'Use a slotted spoon to transfer the chillies and peaches to the warm jars without packing them down firmly.')),
    step('fill_jars', localised('Napełnij i zamknij słoiki', 'Fill and seal the jars'), localised('Zalej zawartość słoików gorącym syropem. Wytrzyj brzegi i zakręć słoiki.', 'Pour the hot syrup over the jar contents. Wipe the rims and fit the lids.')),
    step('cool_and_chill', localised('Ostudź i odstaw do lodówki', 'Cool and refrigerate'), localised('Odstaw słoiki na podkładkę odporną na ciepło. Chłodź przed podaniem.', 'Stand the jars on a heatproof surface. Chill before serving.')),
  ],
);
const cucumberPickles = recipe(
  localised('Zagrycha ogórkowa z curry', 'Sweet-and-sour curry cucumber refrigerator pickles'),
  localised('Ogórki gruntowe z papryką i cebulą w intensywnie żółtej zalewie curry.', 'Pickling cucumbers with red peppers and onions in a vivid yellow curry liquid.'),
  [
    step('prepare-jars', localised('Przygotuj słoiki', 'Prepare the jars'), localised('Umyj słoiki i pokrywki, przygotuj do gorącego napełniania.', 'Wash the jars and lids, prepare them for hot filling.')),
    step('pack-jars', localised('Ułóż dodatki i warzywa', 'Pack the jars'), localised('Rozdziel gorczycę między słoiki. Układaj ogórki dość ciasno, przekładając je papryką, cebulą, marchwią i pasternakiem.', 'Divide mustard seeds between the jars. Pack in the cucumbers fairly closely, alternating with the peppers and onions.')),
    step('fill-and-close', localised('Zalej i zamknij słoiki', 'Fill and close the jars'), localised('Wymieszaj gorącą zalewę przed napełnieniem każdego słoika. Zalej warzywa tak, aby były przykryte.', 'Stir the hot pickling liquid before filling each jar. Pour it over the vegetables to cover them.')),
    step('develop-flavour-and-serve', localised('Odstaw ogórki w lodówce', 'Leave the pickles in the fridge'), localised('Powinny być wyraźnie słodko-kwaśne i nadal jędrne. Podawaj po odsączeniu.', 'They should be distinctly sweet and sour and still firm. Drain and serve chilled.')),
  ],
);

test('finished sauce uses a sauceboat and complete blending even if storage mentions a jar', () => {
  const result = resolveHeroPresentation(sauce)!;
  assert.equal(result.container, 'sauceboat');
  assert(result.evidenceStepIds.includes('blend-sauce'));
  assert.match(result.finalAppearance.pl, /bez widocznych kawałków/);
  assert.match(result.finalAppearance.en, /no visible pieces/);
  assert.match(result.finalAppearance.en, /velvety/);
  assert.equal(isGlassHeroPresentation(result), false);
});

test('both actual preserves use jars and retain the finished pieces', () => {
  for (const value of [cowboyCandy, cucumberPickles]) {
    const result = resolveHeroPresentation(value)!;
    assert.equal(result.container, 'jar');
    assert.equal(isGlassHeroPresentation(result), true);
    assert(!result.evidenceStepIds.some(id => id === 'prepare_jars' || id === 'prepare-jars'));
    assert(!result.finalAppearance.en.includes('blended completely smooth'));
    assert(result.evidenceStepIds.every(id => value.steps.some(step => step.id === id)));
  }
  assert.match(resolveHeroPresentation(cowboyCandy)!.finalAppearance.en, /pieces of peach/);
  assert.match(resolveHeroPresentation(cucumberPickles)!.finalAppearance.en, /yellow/);
});

test('ordinary meals keep a plate, soup gets a bowl, and ingredients do not dictate packaging', () => {
  assert.equal(resolveHeroPresentation(recipes[0])!.container, 'plate');
  const soup = recipes.find(value => value.primaryCategory === 'soup')!;
  assert.equal(resolveHeroPresentation(soup)!.container, 'bowl');
  const storedMeal = { ...recipes[0], storage: localised('Przechowuj w słoiku.', 'Store in a jar.') };
  assert.equal(resolveHeroPresentation(storedMeal)!.container, 'plate');
  const dressedSalad = recipe(localised('Pieczone buraki i feta', 'Roast beetroot and feta'), localised('Buraki z fetą.', 'Beetroot with feta.'), [
    step('dressing', localised('Wymieszaj dressing', 'Mix the dressing'), localised('W małym słoiku połącz oliwę i ocet. Zamknij i wstrząśnij.', 'Combine olive oil and vinegar in a small jar. Close and shake.')),
    step('serve', localised('Ułóż sałatkę', 'Assemble the salad'), localised('Rozłóż rukolę i buraki na półmisku. Polej dressingiem.', 'Arrange the rocket and beetroot on a platter. Drizzle with the dressing.')),
  ]);
  assert.equal(resolveHeroPresentation(dressedSalad)!.container, 'plate');
  assert.equal(suggestHeroPresentation(dressedSalad)!.container, 'platter');
});

test('a chilled soup explicitly served in glasses gains an editable glass suggestion without changing legacy identity', () => {
  const ajo = recipe(localised('Ajo blanco', 'Ajo blanco'), localised('Gładki biały chłodnik migdałowy.', 'A smooth white almond soup.'), [
    step('blend', localised('Zmiksuj na gładko', 'Blend until smooth'), localised('Zmiksuj wszystkie składniki na gładko.', 'Blend all the ingredients until smooth.')),
    step('serve', localised('Podaj chłodnik', 'Serve the chilled soup'), localised('Rozlej chłodnik do schłodzonych kieliszków i podaj od razu.', 'Pour the chilled soup into chilled goblets and serve straight away.')),
  ]);
  ajo.primaryCategory = 'soup';
  const legacy = resolveHeroPresentation(ajo)!;
  assert.equal(legacy.container, 'bowl');
  const suggestion = suggestHeroPresentation(ajo)!;
  assert.equal(suggestion.container, 'glass');
  assert.equal(isGlassHeroPresentation(suggestion), true);
  assert.equal(heroPresentationIssue(ajo, suggestion), null);
  assert(suggestion.evidenceStepIds.includes('serve'));
  assert(suggestion.evidenceStepIds.includes('blend'));
  assert.match(suggestion.finalAppearance.en, /glass or goblet/);
  assert.deepEqual(resolveHeroPresentation(ajo), legacy, 'Viewing a new suggestion cannot reinterpret a legacy approval or accepted job.');
  assert.deepEqual(resolveHeroPresentation({ ...ajo, heroPresentation: suggestion }), suggestion);
});

test('a starter soup with allocated blending water and final grape topping already has a complete glass suggestion', () => {
  const ajo = recipe(localised('Ajo blanco', 'Ajo blanco'), localised('Gładki chłodnik migdałowy z winogronami.', 'Smooth chilled almond soup with grapes.'), [
    step('blend-soup', localised('Zmiksuj gładki chłodnik', 'Blend the soup until smooth'), localised('Dodaj około połowy odmierzonej wody. Miksuj do uzyskania jednolitego gładkiego kremu. Pozostałą wodę dodawaj stopniowo.', 'Add about half the measured cold water. Blend to a uniform smooth cream. Add the remaining water gradually.')),
    step('serve-soup', localised('Podaj w kieliszkach', 'Serve in glasses'), localised('Rozdziel całość między cztery kieliszki. Na każdej porcji ułóż pokrojone winogrona i posyp prażonymi migdałami.', 'Divide the whole batch between four glasses. Top each serving with chopped grapes and toasted almonds.')),
  ]);
  ajo.primaryCategory = 'starter'; ajo.heroPresentation = null;
  const suggestion = suggestHeroPresentation(ajo)!;
  assert.equal(suggestion.container, 'glass');
  assert.equal(heroPresentationIssue(ajo, suggestion), null);
  assert.match(suggestion.finalAppearance.pl, /winogrona/);
  assert.match(suggestion.finalAppearance.en, /grapes and toasted almonds/);
  assert.match(suggestion.finalAppearance.en, /blended base.*smooth/);
  assert.doesNotMatch(suggestion.finalAppearance.en, /no visible pieces of fruit/);
  assert(suggestion.evidenceStepIds.includes('blend-soup'));
  assert(suggestion.evidenceStepIds.includes('serve-soup'));
  assert.equal(resolveHeroPresentation(ajo), null, 'The suggested visible prefill must not mutate the unresolved saved draft.');
});

test('new suggestions still reject a genuinely partly blended soup and keep historical identity unchanged', () => {
  const partial = recipe(localised('Zupa warzywna', 'Vegetable soup'), localised('Zupa z kawałkami warzyw.', 'Soup with pieces of vegetables.'), [
    step('blend', localised('Zmiksuj część zupy', 'Blend a portion of the soup'), localised('Zmiksuj połowę zupy na gładko. Połącz z pozostałą zupą.', 'Blend half the soup until smooth. Combine with the remaining soup.')),
    step('serve', localised('Podaj', 'Serve'), localised('Podaj w misce.', 'Serve in a bowl.')),
  ]);
  assert.equal(suggestHeroPresentation(partial), null);
  assert.equal(resolveHeroPresentation(partial), null);
});

test('drinking-glass recognition uses actual serving, never an ingredient measure or glass material adjective', () => {
  const value = recipe(localised('Chłodnik', 'Chilled soup'), localised('Zupa migdałowa.', 'Almond soup.'), [
    step('measure', localised('Odmierz wodę', 'Measure the water'), localised('Wlej szklankę wody do blendera.', 'Pour a glass of water into the blender.')),
    step('serve', localised('Podaj', 'Serve'), localised('Podaj chłodnik od razu.', 'Serve the chilled soup straight away.')),
  ]);
  value.primaryCategory = 'soup';
  assert.equal(suggestHeroPresentation(value)!.container, 'bowl');
  for (const text of [
    localised('Podaj w szklance.', 'Serve in a glass.'),
    localised('Podaj w kieliszku.', 'Serve in a goblet.'),
    localised('Podaj w małych szklankach.', 'Serve in small tumblers.'),
  ]) {
    const served = { ...value, steps: [value.steps[0], step('serve', localised('Podaj', 'Serve'), text)] };
    assert.equal(suggestHeroPresentation(served)!.container, 'glass');
  }
  for (const text of ['Serve in a glass.', 'Serve in a drinking glass.', 'Serve in a wine glass.', 'Serve in chilled glasses.', 'Serve in a goblet.']) {
    const served = { ...value, steps: [step('serve', localised('Podaj', 'Serve'), localised('Podaj chłodnik.', text))] };
    assert.equal(suggestHeroPresentation(served)!.container, 'glass', text);
  }
  const glassBowl = { ...value, steps: [step('serve', localised('Podaj', 'Serve'), localised('Podaj w szklanej misce.', 'Serve in a glass bowl.'))] };
  assert.equal(suggestHeroPresentation(glassBowl)!.container, 'bowl');
  const glassSideDrink = { ...value, steps: [step('serve', localised('Podaj', 'Serve'), localised('Podaj chłodnik ze szklanką wody.', 'Serve the chilled soup with a glass of water.'))] };
  assert.equal(suggestHeroPresentation(glassSideDrink)!.container, 'bowl');
  const override = resolveHeroPresentationForBrief(value, 'Pokaż gotową potrawę w kieliszku.')!;
  assert.equal(override.container, 'glass');
  assert.equal(resolveHeroPresentation(value)!.container, 'bowl');
});

test('explicit bottling in the method gets a bottle but negation never does', () => {
  const bottled = { ...sauce, steps: [...sauce.steps, step('bottle', localised('Rozlej sos', 'Bottle the sauce'), localised('Przelej gotowy sos do szklanych butelek i zamknij korkami.', 'Pour the finished sauce into glass bottles and close with corks.'))] };
  assert.equal(resolveHeroPresentation(bottled)!.container, 'bottle');
  assert.match(resolveHeroPresentation(bottled)!.finalAppearance.pl, /korkiem/);
  assert.match(resolveHeroPresentation(bottled)!.finalAppearance.en, /cork/);
  const negative = { ...sauce, steps: [...sauce.steps, step('do-not-bottle', localised('Podaj od razu', 'Serve immediately'), localised('Nie przelewaj sosu do butelek.', 'Do not pour the sauce into bottles.'))] };
  assert.equal(resolveHeroPresentation(negative)!.container, 'sauceboat');
});

test('optional or conflicting packaging and incomplete methods require a manual choice', () => {
  const optional = { ...sauce, steps: [...sauce.steps, step('optional-jar', localised('Podaj lub przełóż', 'Serve or pack'), localised('Możesz przełożyć sos do słoika.', 'Optionally pour the sauce into a jar.'))] };
  assert.equal(resolveHeroPresentation(optional), null);
  const conflicting = { ...cowboyCandy, steps: [...cowboyCandy.steps, step('bottle', localised('Przelej', 'Pour'), localised('Przelej syrop do butelki.', 'Pour the syrup into a bottle.'))] };
  assert.equal(resolveHeroPresentation(conflicting), null);
  assert.equal(resolveHeroPresentation({ ...cowboyCandy, steps: [cowboyCandy.steps[0]] }), null);
  assert.equal(resolveHeroPresentation({ ...recipes[0], steps: [] }), null);
});

test('saved valid override wins, suggestions ignore it, and stale evidence does not silently fall back', () => {
  const override = { ...resolveHeroPresentation(sauce)!, container: 'bowl' as const };
  const value = { ...sauce, heroPresentation: override };
  assert.deepEqual(resolveHeroPresentation(value), override);
  assert.equal(suggestHeroPresentation(value)!.container, 'sauceboat');
  assert.equal(heroPresentationIssue(value, override), null);
  assert.equal(resolveHeroPresentation({ ...value, steps: [] }), null);
  assert.match(heroPresentationIssue({ ...value, steps: [] }, override)!, /usunięty/);
});

test('briefs remain bounded and evidence and bilingual completeness are validated', () => {
  const result = suggestHeroPresentation({ ...sauce, description: { pl: 'Długi opis. '.repeat(100), en: 'A long description. '.repeat(100) } })!;
  assert(result.finalAppearance.pl.length <= 600);
  assert(result.finalAppearance.en.length <= 600);
  assert.equal(result.profileVersion, heroPresentationProfile);
  assert.match(heroPresentationIssue(sauce, { ...result, evidenceStepIds: ['blend-sauce', 'blend-sauce'] })!, /powtarzać/);
  assert.match(heroPresentationIssue(sauce, { ...result, finalAppearance: { pl: '', en: 'Smooth sauce' } })!, /PL/);
  assert.match(heroPresentationIssue(sauce, { ...result, evidenceStepIds: [] })!, /krok/);
});

test('explicit unresolved metadata survives independently of the legacy local fallback', () => {
  assert.equal(resolveHeroPresentation({ ...sauce, heroPresentation: null }), null);
  assert.equal(resolveHeroPresentation({ ...sauce, heroPresentation: undefined })!.container, 'sauceboat');
  assert.equal(suggestHeroPresentation({ ...sauce, heroPresentation: null })!.container, 'sauceboat');
  assert.match(heroPresentationIssue(sauce, null)!, /Wybierz naczynie/);
});

test('packing an intermediate dressing in a jar cannot override later plating of the complete meal', () => {
  const salad = recipe(localised('Sałatka z pomidorów', 'Tomato salad'), localised('Pomidory z dressingiem.', 'Tomatoes with dressing.'), [
    step('dressing', localised('Przygotuj dressing', 'Prepare the dressing'), localised('Przelej dressing do słoika i zamknij go.', 'Pour the dressing into a jar and seal the jar.')),
    step('serve', localised('Podaj sałatkę', 'Serve the salad'), localised('Ułóż sałatkę na talerzu i polej dressingiem.', 'Arrange the salad on a plate and drizzle with the dressing.')),
  ]);
  const result = resolveHeroPresentation(salad)!;
  assert.equal(result.container, 'plate');
  assert(result.evidenceStepIds.includes('serve'));
  assert(!result.evidenceStepIds.includes('dressing'));
});

test('meals in sauce are not standalone sauces, while sauce title heads and safe suffixes remain supported', () => {
  for (const title of [
    localised('Łosoś w sosie pomidorowym', 'Salmon in tomato sauce'),
    localised('Tofu z sosem orzechowym', 'Tofu with peanut sauce'),
    localised('Klopsiki w sosie', 'Meatballs in sauce'),
  ]) {
    const meal = recipe(title, localised('Gotowe danie.', 'A finished meal.'), [step('serve', localised('Podaj', 'Serve'), localised('Podawaj na talerzach.', 'Serve on plates.'))]);
    assert.equal(resolveHeroPresentation(meal)!.container, 'plate');
  }
  for (const title of [localised('Sos do makaronu', 'Pasta sauce'), localised('Sos pomidorowy z bazylią', 'Tomato and basil sauce')]) {
    assert.equal(resolveHeroPresentation({ ...sauce, title })!.container, 'sauceboat');
  }
});

test('partial blending or later solid additions do not imply a completely smooth finished dish', () => {
  const partial = recipe(localised('Zupa warzywna', 'Vegetable soup'), localised('Zupa z kawałkami warzyw.', 'A soup with pieces of vegetables.'), [
    step('blend', localised('Zmiksuj część', 'Blend a portion'), localised('Zmiksuj połowę zupy na gładko. Połącz z pozostałą zupą.', 'Blend half the soup until smooth. Combine with the remaining soup.')),
    step('serve', localised('Podaj', 'Serve'), localised('Podaj gorącą.', 'Serve hot.')),
  ]);
  assert.equal(resolveHeroPresentation(partial), null);
  const chunkySauce = { ...sauce, steps: [...sauce.steps, step('add-pieces', localised('Dodaj owoce', 'Add fruit'), localised('Dodaj kawałki brzoskwini.', 'Add diced peaches.'))] };
  assert.equal(resolveHeroPresentation(chunkySauce), null);
  const sameStep = { ...sauce, steps: [step('blend-and-fold', localised('Przygotuj sos', 'Prepare the sauce'), localised('Zmiksuj sos na gładko. Dodaj kawałki gruszki.', 'Blend the sauce until smooth. Fold in diced pears.'))] };
  assert.equal(resolveHeroPresentation(sameStep), null);
  const blendedDressing = recipe(localised('Sałatka z sosem', 'Salad with dressing'), localised('Sałatka z dressingiem.', 'A salad with dressing.'), [
    step('blend-dressing', localised('Zmiksuj dressing', 'Blend dressing'), localised('Zmiksuj dressing na gładko.', 'Blend the dressing until smooth.')),
    step('serve', localised('Podaj', 'Serve'), localised('Podaj sałatkę na talerzu.', 'Serve the salad on a plate.')),
  ]);
  assert.equal(resolveHeroPresentation(blendedDressing), null);
});


test('dish-defining clay cookware and the final yolk garnish survive the final appearance brief', () => {
  const chicken = recipe(
    localised('Kurczak z ryżem w glinianym garnku', 'Clay pot chicken and rice'),
    localised('Bardzo długi opis aromatu. '.repeat(60), 'A long description of its aroma. '.repeat(60)),
    [
      step('cook', localised('Ugotuj ryż z kurczakiem', 'Cook the chicken and rice'), localised('Gotuj kurczaka i ryż w glinianym garnku, aż ryż wchłonie wodę.', 'Cook the chicken and rice in a clay pot until the rice absorbs the water.')),
      step('garnish', localised('Wykończ i podaj', 'Finish and serve'), localised('Na wierzchu ułóż marynowane żółtko. Podaj od razu w glinianym garnku.', 'Top with the marinated egg yolk. Serve immediately in the clay pot.')),
    ],
  );
  const result = suggestHeroPresentation(chicken)!;
  assert.equal(result.container, 'clay-pot');
  assert.match(result.finalAppearance.pl, /marynowane żółtko/);
  assert.match(result.finalAppearance.en, /marinated egg yolk/);
  assert(result.evidenceStepIds.includes('garnish'));
  assert.equal(heroPresentationIssue(chicken, result), null);
  // The title still establishes the cookware when the last step only adds a topping.
  chicken.steps[1].text = localised('Na wierzchu ułóż marynowane żółtko.', 'Top with the marinated egg yolk.');
  assert.equal(suggestHeroPresentation(chicken)!.container, 'clay-pot');
});

test('the final serving vessel outranks earlier cookware, including a dish-defining pot', () => {
  const cooked = recipe(localised('Ryż w glinianym garnku', 'Clay pot rice'), localised('Ryż.', 'Rice.'), [
    step('cook', localised('Ugotuj', 'Cook'), localised('Gotuj ryż w glinianym garnku.', 'Cook the rice in a clay pot.')),
    step('serve', localised('Podaj', 'Serve'), localised('Podawaj na talerzach.', 'Serve on plates.')),
  ]);
  assert.equal(suggestHeroPresentation(cooked)!.container, 'plate');
  for (const [container, pl, en] of [
    ['pan', 'Podawaj prosto z patelni.', 'Serve directly from the skillet.'],
    ['pot', 'Podawaj w garnku.', 'Serve in the cooking pot.'],
    ['baking-dish', 'Podawaj w naczyniu żaroodpornym.', 'Serve in the baking dish.'],
    ['bowl', 'Podawaj w misce.', 'Serve in a bowl.'],
  ] as const) {
    cooked.steps[1].text = localised(pl, en);
    assert.equal(suggestHeroPresentation(cooked)!.container, container);
  }
});

test('natural-language vessel requests are photo-only and ignore explicitly rejected vessels', () => {
  const value = { ...sauce, heroPresentation: { ...resolveHeroPresentation(sauce)!, container: 'plate' as const } };
  const requested = resolveHeroPresentationForBrief(value, 'Pokaż gotowy sos w glinianym garnku zamiast talerza.')!;
  assert.equal(requested.container, 'clay-pot');
  assert.equal(value.heroPresentation.container, 'plate');
  assert.match(requested.finalAppearance.en, /clay pot/);
  assert.deepEqual(requested.evidenceStepIds, value.heroPresentation.evidenceStepIds);
  assert.equal(resolveHeroPresentationForBrief(value, 'Bez talerza. Pokaż sos w misce.')!.container, 'bowl');
  assert.equal(resolveHeroPresentationForBrief(value, 'Do not use a bottle. Keep the sauce smooth.')!.container, 'plate');
  assert.equal(resolveHeroPresentationForBrief(value, 'Use a skillet instead of a plate.')!.container, 'pan');
});


test('replacement phrasing chooses the requested vessel rather than the rejected one', () => {
  const value = { ...sauce, heroPresentation: { ...resolveHeroPresentation(sauce)!, container: 'plate' as const } };
  for (const text of [
    'Zamiast talerza użyj glinianego garnka.',
    'Zamiast talerza w glinianym garnku.',
    'Use a clay pot instead of a plate.',
    'Instead of a plate, show it in a clay pot.',
    'Nie gliniany garnek, tylko miska. Ostatecznie użyj glinianego garnka.',
  ]) assert.equal(resolveHeroPresentationForBrief(value, text)!.container, 'clay-pot', text);
  for (const text of ['Bez talerza i miski.', 'Do not use a clay pot.', 'Bez glinianego garnka.']) {
    assert.equal(resolveHeroPresentationForBrief(value, text)!.container, 'plate', text);
  }
});


test('equipment cleanup in a serving step cannot replace the final plated food', () => {
  const value = recipe(localised('Kurczak z ryżem', 'Chicken and rice'), localised('Danie z ryżem.', 'A rice dish.'), [
    step('assemble', localised('Ułóż kurczaka', 'Arrange the chicken'), localised('Ułóż kurczaka na patelni i podsmaż.', 'Arrange the chicken in the pan and fry.')),
    step('serve', localised('Podaj', 'Serve'), localised('Przełóż potrawę na talerz. Odstaw garnek do wystudzenia.', 'Transfer the food to a plate. Leave the pot to cool.')),
  ]);
  assert.equal(suggestHeroPresentation(value)!.container, 'plate');
  value.steps[1].text = localised('Podawaj od razu.', 'Serve immediately.');
  assert.equal(suggestHeroPresentation(value)!.container, 'plate', 'An intermediate assembly pan is not a final vessel.');
});


test('legacy inferred presentation retains its original exact appearance and evidence contract', () => {
  const value = recipe(localised('Kurczak z ryżem w glinianym garnku', 'Clay pot chicken and rice'), localised('Ryż z kurczakiem.', 'Chicken and rice.'), [
    step('cook', localised('Gotuj', 'Cook'), localised('Gotuj ryż z kurczakiem w glinianym garnku.', 'Cook the chicken and rice in the clay pot.')),
    step('serve', localised('Podaj', 'Serve'), localised('Na wierzchu ułóż marynowane żółtko. Podawaj w glinianym garnku.', 'Top with the marinated egg yolk. Serve in the clay pot.')),
  ]);
  assert.deepEqual(resolveHeroPresentation(value), {
    container: 'plate',
    finalAppearance: { pl: 'Gotowa potrawa na talerzu. Ryż z kurczakiem.', en: 'The finished dish on a plate. Chicken and rice.' },
    evidenceStepIds: ['serve'], profileVersion: heroPresentationProfile,
  });
  const suggestion = suggestHeroPresentation(value)!;
  assert.equal(suggestion.container, 'clay-pot');
  assert.match(suggestion.finalAppearance.en, /marinated egg yolk/);
  assert.deepEqual(resolveHeroPresentationForBrief(value, 'Pokaż gotową potrawę.'), suggestion);
  assert.equal(value.heroPresentation, undefined, 'Admission suggestions cannot rewrite the approved recipe.');
});
