import { recipes, type Localised } from "./recipes";
import { staticIngredientPhotoOverride } from './static-ingredient-photos';

export type MediaTile = { src: string; columns: number; rows: number; index: number; alt: Localised; caption?: Localised; aspectRatio?: number };
const ingredientTiles: Record<string, [number, number]> = {
  pasta: [1,0], butter: [1,1], "tin-butter": [1,1], cream: [1,2], cheese: [1,3], basil: [1,5], salt: [1,6], "dough-salt": [1,6], "cooking-salt": [1,6], pepper: [1,7], "pasta-water": [1,8], water: [1,8], pumpkin: [1,9], onion: [1,10], garlic: [1,11],
  ginger: [2,0], "olive-oil": [2,1], oil: [2,1], "filling-oil": [2,1], "frying-oil": [2,1], "roasting-oil": [2,1], "dressing-oil": [2,1], stock: [2,2], "coconut-milk": [2,3], "pumpkin-seeds": [2,4], flour: [2,5], "dusting-flour": [2,5], spinach: [2,6], ricotta: [2,7], nutmeg: [2,8], sage: [2,9], eggs: [2,10], egg: [2,10], milk: [2,11],
  sugar: [3,0], "filling-sugar": [3,0], "baking-powder": [3,1], berries: [3,2], honey: [3,3], apples: [3,4], cinnamon: [3,5], "icing-sugar": [3,6], beetroot: [3,7], rocket: [3,8], feta: [3,9], walnuts: [3,10], vinegar: [3,11],
};
const cues: Record<string, Localised[]> = {
  "lemon-pasta": [
    {pl:"Zetrzyj tylko żółtą część skórki — biała warstwa jest gorzka.",en:"Grate only the yellow zest — the white pith is bitter."},
    {pl:"Wstążki powinny być sprężyste. Zachowaj mętną wodę z gotowania.",en:"The ribbons should retain a little bite. Save the cloudy cooking water."},
    {pl:"Gładki, jasny sos ogrzewaj łagodnie, bez mocnego wrzenia.",en:"Warm the pale, smooth sauce gently without a rapid boil."},
    {pl:"Sos ma cienko otulać wstążki. Dolewaj wodę stopniowo.",en:"The sauce should lightly coat the ribbons. Add the water a little at a time."},
    {pl:"Bazylia i drobno starty ser trafiają na talerz tuż przed podaniem.",en:"Add basil and finely grated cheese just before serving."},
  ],
  "pumpkin-soup": [
    {pl:"Miękka dynia z lekko złotymi brzegami; bez przypalonych kawałków.",en:"Soft pumpkin with lightly golden edges, without burnt pieces."},
    {pl:"Cebula jest szklista i miękka. Czosnek nie powinien się przypalić.",en:"The onion should be soft and translucent. Avoid burning the garlic."},
    {pl:"Małe bąbelki oznaczają spokojne gotowanie, nie gwałtowne wrzenie.",en:"Small bubbles indicate a gentle simmer rather than a rolling boil."},
    {pl:"Krem ma być aksamitny, bez widocznych kawałków dyni.",en:"The soup should be velvety, with no visible pumpkin pieces."},
    {pl:"Lekko podprażone pestki dodają chrupkości gładkiej zupie.",en:"Lightly toasted seeds add crunch to the smooth soup."},
  ],
  "spinach-pierogi": [
    {pl:"Ciasto po wyrobieniu jest gładkie i elastyczne.",en:"The kneaded dough should be smooth and elastic."},
    {pl:"Dobrze odciśnięty szpinak nie zostawia kałuży wody.",en:"Well-squeezed spinach should not leave a pool of water."},
    {pl:"Nadzienie jest zwarte i trzyma się na łyżce.",en:"The filling should hold together on a spoon."},
    {pl:"Brzegi są dokładnie zlepione, a płat ciasta ma około 2 mm.",en:"Seal the edges firmly; the dough sheet is about 2 mm thick."},
    {pl:"Pierogi wypływają w wodzie, która gotuje się łagodnie.",en:"The pierogi float in gently simmering water."},
    {pl:"Masło z szałwią jest jasne i pachnące, bez spalonych liści.",en:"The sage butter is pale and fragrant, without burnt leaves."},
  ],
  "ricotta-pancakes": [
    {pl:"Drobne grudki ricotty są w porządku — nie trzeba ich rozbijać.",en:"Small ricotta curds are fine; there is no need to beat them out."},
    {pl:"Gęsta masa z drobnymi grudkami; mieszaj tylko do połączenia.",en:"A thick, slightly lumpy batter; fold only until combined."},
    {pl:"Brzegi zaczynają się ścinać, zanim odwrócisz placuszek.",en:"Wait for the edges to begin setting before turning."},
    {pl:"Spód jest równomiernie złoty, a środek dopieczony.",en:"Look for an evenly golden underside and a cooked centre."},
    {pl:"Miękki, puszysty środek i owoce dodane na końcu.",en:"A soft, fluffy centre, with berries added at the end."},
  ],
  "apple-cake": [
    {pl:"Mąka z masłem przypomina okruchy; ciasta nie wyrabiaj długo.",en:"The butter and flour resemble crumbs; avoid overworking the pastry."},
    {pl:"Większa część na spód, mniejsza na wierzch — obie do schłodzenia.",en:"The larger piece forms the base; chill both pieces."},
    {pl:"Jabłka miękną, a nadmiar soku odparowuje.",en:"The apples soften as the excess juice evaporates."},
    {pl:"Warstwa jabłek jest przykryta luźną kruszonką z ciasta.",en:"Cover the apple layer with loose pastry crumbs."},
    {pl:"Złote brzegi i wierzch; czas zależy również od formy i piekarnika.",en:"Golden edges and topping; timing also depends on the tin and oven."},
    {pl:"Po ostudzeniu nadzienie trzyma kształt podczas krojenia.",en:"Once cool, the filling holds its shape when sliced."},
  ],
  "beetroot-salad": [
    {pl:"Pieczone buraki mają lekko zrumienione brzegi i są miękkie.",en:"The roasted beetroot is tender with lightly caramelised edges."},
    {pl:"Orzechy są lekko złote. Zdejmij je z patelni, zanim się przypalą.",en:"The walnuts are lightly golden. Remove them before they burn."},
    {pl:"Po potrząśnięciu składniki tworzą jednolity, lekko mętny dressing.",en:"Shaking produces a uniform, slightly cloudy dressing."},
    {pl:"Dressing lekko pokrywa liście; feta i orzechy zachowują strukturę.",en:"The dressing lightly coats the leaves; feta and walnuts keep their texture."},
  ],
};

export function getIngredientImage(recipeId: string, ingredientId: string): MediaTile {
  const tile = ingredientTiles[ingredientId];
  const ingredient = recipes.find(recipe => recipe.id === recipeId)?.ingredients.find(item => item.id === ingredientId);
  if (!ingredient) throw new Error(`Missing ingredient photograph: ${recipeId}/${ingredientId}`);
  const override = staticIngredientPhotoOverride(recipeId, ingredient);
  if (override) return override;
  if (!tile) throw new Error(`Missing ingredient photograph: ${recipeId}/${ingredientId}`);
  return { src: `/images/ingredients-${tile[0]}.webp`, columns: 4, rows: 3, index: tile[1], alt: ingredient.name };
}
export function getStepImage(recipeId: string, stepId: string): MediaTile {
  const recipe = recipes.find(item => item.id === recipeId);
  const index = recipe?.steps.findIndex(step => step.id === stepId) ?? -1;
  const caption = cues[recipeId]?.[index];
  if (index < 0 || !caption) throw new Error(`Missing step photograph: ${recipeId}/${stepId}`);
  const aspectRatio = ["spinach-pierogi", "ricotta-pancakes", "beetroot-salad"].includes(recipeId) ? 2.25 : 1.5;
  return { src: `/images/steps-${recipeId}.webp`, columns: 2, rows: 3, index, alt: caption, caption, aspectRatio };
}
