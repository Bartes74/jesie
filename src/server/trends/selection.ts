import type { Localised } from '@/lib/recipes';
import type { RecipeDietId } from '@/lib/recipe-diet';
import { candidateDiet, dietBalanceTarget, dietSelection, type TrendDietBalance } from './diet-balance';
import type { TrendCandidate } from '@/lib/trend-types';
import { normaliseDish, rankCandidates, warsawDate, type ExistingDish, type RawCandidate } from './ranking';

type Season = 'spring' | 'summer' | 'autumn' | 'winter';
type Idea = { title: Localised; diet: RecipeDietId; season: Season | 'any'; aliases?: string[] };

const ideas: Idea[] = [
    ...[
        ['Risotto ze szparagami i cytryną', 'Asparagus and lemon risotto', 'vegetarian'],
        ['Tarta ze szpinakiem i serem kozim', 'Spinach and goat cheese tart', 'vegetarian'],
        ['Młode ziemniaki z koperkiem i sosem jogurtowym', 'New potatoes with dill and yoghurt sauce', 'vegetarian'],
        ['Krem z zielonego groszku z miętą', 'Green pea soup with mint', 'vegan'],
        ['Makaron z pesto z rzodkiewkowych liści', 'Pasta with radish leaf pesto', 'vegan'],
        ['Sałatka z bobu, rzodkiewek i fety', 'Broad bean, radish and feta salad', 'vegetarian'],
        ['Pieczone szparagi z jajkiem i orzechami', 'Roasted asparagus with egg and hazelnuts', 'vegetarian'],
        ['Gnocchi z groszkiem i masłem szałwiowym', 'Gnocchi with peas and sage butter', 'vegetarian'],
        ['Placuszki z cukinii z dipem koperkowym', 'Courgette fritters with dill dip', 'vegetarian'],
        ['Tosty z ricottą, rzodkiewką i szczypiorkiem', 'Ricotta, radish and chive toast', 'vegetarian'],
        ['Pęczotto z botwinką i serem kozim', 'Barley risotto with beet greens and goat cheese', 'vegetarian'],
        ['Kurczak z cytryną i młodą marchewką', 'Lemon chicken with baby carrots', 'meat'],
        ['Omlet ze szczawiem i kremowym twarożkiem', 'Sorrel omelette with creamy curd cheese', 'vegetarian'],
        ['Pieczona kalarepa z sosem tahini', 'Roasted kohlrabi with tahini sauce', 'vegan'],
        ['Galette z rabarbarem i migdałami', 'Rhubarb and almond galette', 'vegetarian'],
        ['Deser jogurtowy z rabarbarem i kruszonką', 'Yoghurt dessert with rhubarb and crumble', 'vegetarian'],
        ['Pstrąg z pieczoną rzodkiewką i ziemniakami', 'Trout with roasted radishes and potatoes', 'meat'],
        ['Klopsiki z indyka z koperkiem i kaszą jęczmienną', 'Turkey meatballs with dill and pearl barley', 'meat'],
        ['Schab duszony z marchewką i groszkiem', 'Pork loin braised with carrots and peas', 'meat'],
        ['Wołowina stir-fry ze szparagami i ryżem', 'Beef and asparagus stir-fry with rice', 'meat'],
    ].map(([pl, en, diet]) => ({ title: { pl, en }, diet: diet as RecipeDietId, season: 'spring' as const })),
    ...[
        ['Sałatka z pomidorów, brzoskwiń i burraty', 'Tomato, peach and burrata salad', 'vegetarian'],
        ['Gazpacho z ogórkiem i papryką', 'Cucumber and pepper gazpacho', 'vegan'],
        ['Makaron z pieczonymi pomidorami i bazylią', 'Pasta with roasted tomatoes and basil', 'vegan'],
        ['Grillowana cukinia z cytryną i pistacjami', 'Grilled courgette with lemon and pistachios', 'vegan'],
        ['Tarta z pomidorami i musztardą francuską', 'Tomato and wholegrain mustard tart', 'vegetarian'],
        ['Sałatka z arbuza, ogórka i fety', 'Watermelon, cucumber and feta salad', 'vegetarian'],
        ['Pieczony bakłażan z jogurtem i granatem', 'Roasted aubergine with yoghurt and pomegranate', 'vegetarian'],
        ['Kuskus z grillowanymi warzywami i ziołami', 'Couscous with grilled vegetables and herbs', 'vegan'],
        ['Chłodnik z botwinki z jajkiem', 'Chilled beet green soup with egg', 'vegetarian'],
        ['Kukurydza z masłem limonkowym i chili', 'Sweetcorn with lime and chilli butter', 'vegetarian'],
        ['Szaszłyki z halloumi i brzoskwiniami', 'Halloumi and peach skewers', 'vegetarian'],
        ['Tacos z rybą i surówką z czerwonej kapusty', 'Fish tacos with red cabbage slaw', 'meat'],
        ['Sałatka ziemniaczana z fasolką szparagową', 'Potato and green bean salad', 'vegan'],
        ['Galette z borówkami i cytryną', 'Blueberry and lemon galette', 'vegetarian'],
        ['Pieczone morele z miodem i tymiankiem', 'Roasted apricots with honey and thyme', 'vegetarian'],
        ['Sorbet malinowy z limonką', 'Raspberry and lime sorbet', 'vegan'],
        ['Kurczak z patelni z cukinią i pomidorami', 'Skillet chicken with courgettes and tomatoes', 'meat'],
        ['Dorsz pieczony z papryką i ziemniakami', 'Baked cod with peppers and potatoes', 'meat'],
        ['Szaszłyki z indyka z brzoskwiniami i ryżem', 'Turkey and peach skewers with rice', 'meat'],
        ['Wołowina z fasolką szparagową i makaronem ryżowym', 'Beef with green beans and rice noodles', 'meat'],
    ].map(([pl, en, diet]) => ({ title: { pl, en }, diet: diet as RecipeDietId, season: 'summer' as const })),
    ...[
        ['Risotto z pieczoną dynią i szałwią', 'Roasted pumpkin and sage risotto', 'vegetarian'],
        ['Makaron z grzybami i kremowym sosem tymiankowym', 'Mushroom pasta with creamy thyme sauce', 'vegan'],
        ['Gnocchi z pieczoną dynią i orzechami włoskimi', 'Gnocchi with roasted pumpkin and walnuts', 'vegetarian'],
        ['Tarta z porem i serem pleśniowym', 'Leek and blue cheese tart', 'vegetarian'],
        ['Pieczony seler z sosem orzechowym', 'Roasted celeriac with walnut sauce', 'vegan'],
        ['Pęczak z grzybami i natką pietruszki', 'Pearl barley with mushrooms and parsley', 'vegan'],
        ['Sałatka z gruszką, rukolą i serem kozim', 'Pear, rocket and goat cheese salad', 'vegetarian'],
        ['Krem z pasternaku z prażonymi migdałami', 'Parsnip soup with toasted almonds', 'vegan'],
        ['Kasza gryczana z pieczonymi burakami i chrzanem', 'Buckwheat with roasted beetroot and horseradish', 'vegan'],
        ['Pieczony kalafior z kremem z białej fasoli', 'Roasted cauliflower with white bean cream', 'vegan'],
        ['Kurczak pieczony z jabłkami i majerankiem', 'Roast chicken with apples and marjoram', 'meat'],
        ['Ciecierzyca z dynią w sosie pomidorowym', 'Chickpeas and pumpkin in tomato sauce', 'vegan'],
        ['Zapiekanka ziemniaczana z porem i rozmarynem', 'Potato and leek bake with rosemary', 'vegan'],
        ['Tosty z grzybami i jajkiem w koszulce', 'Mushroom toast with poached egg', 'vegetarian'],
        ['Crumble ze śliwkami i płatkami owsianymi', 'Plum and oat crumble', 'vegetarian'],
        ['Pieczone jabłka z tahini i cynamonem', 'Baked apples with tahini and cinnamon', 'vegan'],
        ['Gulasz wołowy z grzybami i kaszą gryczaną', 'Beef and mushroom stew with buckwheat', 'meat'],
        ['Polędwiczka wieprzowa z gruszką i puree z selera', 'Pork tenderloin with pears and celeriac mash', 'meat'],
        ['Dorsz z soczewicą i pieczonymi burakami', 'Cod with lentils and roasted beetroot', 'meat'],
        ['Pulpety z indyka w sosie pomidorowym z kaszą', 'Turkey meatballs in tomato sauce with barley', 'meat'],
    ].map(([pl, en, diet]) => ({ title: { pl, en }, diet: diet as RecipeDietId, season: 'autumn' as const })),
    ...[
        ['Dhal z czerwonej soczewicy i mleka kokosowego', 'Red lentil and coconut dhal', 'vegan'],
        ['Zapiekanka z białą fasolą i pomidorami', 'White bean and tomato bake', 'vegan'],
        ['Krem z pieczonego czosnku i ziemniaków', 'Roasted garlic and potato soup', 'vegan'],
        ['Pieczona marchew z harissą i jogurtem', 'Harissa roasted carrots with yoghurt', 'vegetarian'],
        ['Makaron z jarmużem, cytryną i orzechami', 'Kale pasta with lemon and walnuts', 'vegan'],
        ['Soczewica z grzybami i puree z selera', 'Lentils with mushrooms and celeriac mash', 'vegan'],
        ['Zupa cebulowa z grzanką serową', 'Onion soup with cheese toast', 'vegetarian'],
        ['Kaszotto z porem i pieczarkami', 'Barley risotto with leek and mushrooms', 'vegetarian'],
        ['Pieczone ziemniaki z kremem z fasoli i koperkiem', 'Baked potatoes with bean cream and dill', 'vegan'],
        ['Gulasz z ciecierzycy, marchewki i suszonych moreli', 'Chickpea, carrot and dried apricot stew', 'vegan'],
        ['Tarta z czerwoną cebulą i tymiankiem', 'Red onion and thyme tart', 'vegetarian'],
        ['Klopsiki z indyka w sosie paprykowym', 'Turkey meatballs in pepper sauce', 'meat'],
        ['Pieczony łosoś z musztardą i purée z groszku', 'Mustard baked salmon with pea purée', 'meat'],
        ['Sałatka z pomarańczą, koprem włoskim i oliwkami', 'Orange, fennel and olive salad', 'vegan'],
        ['Gruszki pieczone z imbirem i orzechami', 'Baked pears with ginger and walnuts', 'vegan'],
        ['Ryż na mleku z pomarańczą i kardamonem', 'Rice pudding with orange and cardamom', 'vegetarian'],
        ['Duszona wołowina z marchewką i ziemniaczanym puree', 'Braised beef with carrots and mashed potatoes', 'meat'],
        ['Kurczak z porem i białą fasolą', 'Chicken with leeks and white beans', 'meat'],
        ['Śledź z pieczonym burakiem i jabłkiem', 'Herring with roasted beetroot and apple', 'meat'],
        ['Schab z kiszoną kapustą i ziemniakami', 'Pork loin with sauerkraut and potatoes', 'meat'],
    ].map(([pl, en, diet]) => ({ title: { pl, en }, diet: diet as RecipeDietId, season: 'winter' as const })),
    ...[
        ['Szakszuka z ciecierzycą i szpinakiem', 'Chickpea and spinach shakshuka', 'vegetarian'],
        ['Makaron z sosem z pieczonej papryki i migdałów', 'Pasta with roasted pepper and almond sauce', 'vegan'],
        ['Chrupiąca sałatka z ryżem i ogórkiem', 'Crispy rice and cucumber salad', 'vegan'],
        ['Miska ryżu z tofu, brokułem i sosem sezamowym', 'Rice bowl with tofu, broccoli and sesame sauce', 'vegan'],
        ['Pieczona feta z białą fasolą i pomidorami', 'Baked feta with white beans and tomatoes', 'vegetarian'],
        ['Placki z czerwonej soczewicy z jogurtem', 'Red lentil pancakes with yoghurt', 'vegetarian'],
        ['Sałatka z makaronem soba i edamame', 'Soba noodle and edamame salad', 'vegan'],
        ['Jajka po turecku z masłem paprykowym', 'Turkish eggs with paprika butter', 'vegetarian'],
        ['Kanapki z pastą z ciecierzycy i kiszonym ogórkiem', 'Chickpea spread and pickle sandwiches', 'vegan'],
        ['Makaron orzo z cytryną i szpinakiem', 'Lemon and spinach orzo', 'vegan'],
        ['Pieczarki faszerowane soczewicą i parmezanem', 'Mushrooms stuffed with lentils and Parmesan', 'meat'],
        ['Wytrawne gofry z serem i szczypiorkiem', 'Savoury cheese and chive waffles', 'vegetarian'],
        ['Pieczony ryż z warzywami i jajkiem', 'Baked vegetable and egg rice', 'vegetarian'],
        ['Zupa pomidorowa z masłem orzechowym', 'Tomato and peanut soup', 'vegan'],
        ['Sałatka z fasolą, tuńczykiem i cebulą', 'Bean, tuna and onion salad', 'meat'],
        ['Pasta kanapkowa z pieczonej marchewki i tahini', 'Roasted carrot and tahini spread', 'vegan'],
        ['Zupa z kurczakiem, soczewicą i pomidorami', 'Chicken lentil and tomato soup', 'meat'],
        ['Tortille z wołowiną, fasolą i papryką', 'Beef bean and pepper tortillas', 'meat'],
        ['Ryż z krewetkami i brokułem', 'Prawn and broccoli rice', 'meat'],
        ['Makaron z sardynkami, pomidorami i pietruszką', 'Pasta with sardines tomatoes and parsley', 'meat'],
    ].map(([pl, en, diet]) => ({ title: { pl, en }, diet: diet as RecipeDietId, season: 'any' as const })),
];

function stableHash(value: string) {
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return hash >>> 0;
}

export function warsawSeason(now = new Date()): Season {
    const month = Number(warsawDate(now).slice(5, 7));
    return month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
}

/** A local editorial reserve, never purported evidence of an online trend. */
export function seasonalRecipeIdeas(now = new Date()): RawCandidate[] {
    const season = warsawSeason(now);
    const day = warsawDate(now);
    return ideas.toSorted((a, b) => Number(b.season === season) - Number(a.season === season)
        || Number(b.season === 'any') - Number(a.season === 'any')
        || stableHash(`${day}:${a.title.en}`) - stableHash(`${day}:${b.title.en}`)
        || a.title.en.localeCompare(b.title.en)).map(idea => ({
        dishKey: normaliseDish(idea.title.en),
        title: { ...idea.title },
        aliases: [...(idea.aliases ?? [])],
        diet: idea.diet,
        rationale: idea.season === season ? 'Autorski pomysł z lokalnego banku inspiracji dopasowany do bieżącej pory roku w Polsce.' : 'Autorski pomysł z lokalnego banku inspiracji na urozmaicenie domowego gotowania.',
        sources: [],
    }));
}

function meaningfulName(title: string) {
    return normaliseDish(title).length >= 3 && /\p{L}/u.test(title);
}

function meaningfulTitle(candidate: { title: Localised }) {
    return [candidate.title.pl, candidate.title.en].every(meaningfulName);
}

function namedRecipe(recipe: ExistingDish) {
    return Boolean(recipe.id.trim()) && [recipe.title.pl, recipe.title.en].some(meaningfulName);
}

function compareEvidence(a: TrendCandidate, b: TrendCandidate) {
    return Number(b.sources.length > 0) - Number(a.sources.length > 0)
        || b.score.independentSources - a.score.independentSources
        || b.sources.length - a.sources.length
        || b.score.platforms - a.score.platforms
        || b.score.newestAt.localeCompare(a.score.newestAt)
        || a.dishKey.localeCompare(b.dishKey)
        || a.id.localeCompare(b.id);
}

/**
 * Select exactly one recipe idea. Trend qualification remains rankCandidates' concern.
 * A catalog selection points to duplicateRecipeId: callers reuse that recipe instead
 * of creating a second draft or starting its text/photo generation workflow.
 */
export function selectRecipeCandidate(candidates: TrendCandidate[], existing: ExistingDish[], runId: string, now = new Date(), balance?: TrendDietBalance): { candidates: TrendCandidate[]; selected: TrendCandidate } {
    const evaluated = structuredClone(candidates).map(candidate => ({ ...candidate, selected: false }));
    // New drafts initially have only their Polish title. Their real dish identity
    // still excludes the same inspiration from the next scheduled or manual run.
    const catalog = existing.filter(namedRecipe);
    for (const candidate of evaluated) {
        const [checked] = rankCandidates([candidate], candidate.sources.map(source => source.url), catalog, runId, now);
        if (checked?.duplicateRecipeId) {
            candidate.duplicateRecipeId = checked.duplicateRecipeId;
            candidate.ambiguous = checked.ambiguous;
            candidate.eligible = false;
            candidate.rejectionReason = checked.rejectionReason;
        }
    }
    const safe = evaluated.filter(candidate => !candidate.duplicateRecipeId && !candidate.ambiguous && meaningfulTitle(candidate));
    const ordered = safe.toSorted(compareEvidence);
    const target = balance ? dietBalanceTarget(balance).target : undefined;
    const preferred = target ? ordered.filter(candidate => candidateDiet(candidate) === target) : ordered;
    let selected = preferred.find(candidate => candidate.eligible) ?? preferred[0];
    // A known seasonal idea of the needed category is better than repeatedly
    // adding the overrepresented category after an unproductive discovery.
    const reserve = seasonalRecipeIdeas(now).flatMap(idea => {
        const [checked] = rankCandidates([idea], [], catalog, runId, now);
        return checked.duplicateRecipeId || checked.ambiguous ? [] : [checked];
    });
    const preferredReserve = target ? reserve.filter(candidate => candidate.diet === target) : reserve;
    if (!selected && !preferredReserve.length) selected = ordered.find(candidate => candidate.eligible) ?? ordered[0];
    if (selected) {
        if (selected.eligible) delete selected.automaticSelection;
        else selected.automaticSelection = {
            basis: 'research',
            reason: selected.sources.length
                ? 'Wybrano najlepiej udokumentowaną nową inspirację z wyszukiwania. Zebrane materiały nie potwierdzają wszystkich kryteriów aktualnego trendu.'
                : 'Wybrano nową potrawę wskazaną w wyszukiwaniu. Nie potwierdzono materiałów źródłowych ani aktualnego trendu; przepis zostanie opracowany jako autorska inspiracja.',
        };
    } else {
        const idea = preferredReserve[0] ?? reserve[0];
        if (idea) selected = { ...idea, id: `${runId}-seasonal-${stableHash(idea.dishKey).toString(36)}`, automaticSelection: { basis: 'seasonal', reason: idea.rationale + ' Nie jest to potwierdzony trend i nie przypisano mu zewnętrznych źródeł.' } };
        if (!selected) {
            const recipe = catalog.toSorted((a, b) => Number(meaningfulTitle(b)) - Number(meaningfulTitle(a))
                || stableHash(`${warsawDate(now)}:${a.id}`) - stableHash(`${warsawDate(now)}:${b.id}`) || a.id.localeCompare(b.id))[0];
            const title = { pl: meaningfulName(recipe.title.pl) ? recipe.title.pl : recipe.title.en, en: meaningfulName(recipe.title.en) ? recipe.title.en : recipe.title.pl };
            // With an exhausted reserve, at least one meaningful existing dish must
            // have matched it. This also avoids fabricating numbered dish variants.
            selected = {
                id: `${runId}-catalog`, runId, dishKey: normaliseDish(title.en) || normaliseDish(title.pl), title, aliases: [...(recipe.aliases ?? [])],
                rationale: 'Powrót do znanej potrawy z książki po wykorzystaniu lokalnego banku nowych inspiracji.', sources: [], eligible: false,
                ...(recipe.diet ? { diet: recipe.diet } : {}),
                rejectionReason: 'Potrawa znajduje się już w książce; należy wykorzystać istniejący przepis, bez tworzenia duplikatu.', duplicateRecipeId: recipe.id, ambiguous: false,
                score: { independentSources: 0, newestAt: '', platforms: 0 }, selected: false, research: { foundSources: 0, verifiedSources: 0, issues: [] },
                automaticSelection: { basis: 'catalog', reason: 'Wszystkie pomysły z lokalnego banku są już opracowane lub podobne do istniejących. Wybrano ponownie istniejący przepis bez nowego opracowania i bez oznaczenia aktualnego trendu.' },
            };
        }
        evaluated.push(selected);
    }
    const intendedDiet = candidateDiet(selected);
    if (intendedDiet) selected.diet = intendedDiet;
    else delete selected.diet;
    if (balance) selected.dietSelection = dietSelection(balance, intendedDiet);
    selected.selected = true;
    return { candidates: evaluated, selected };
}
