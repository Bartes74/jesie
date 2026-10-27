import type { Recipe, RecipeStep } from './recipes';

export type StepPhotoRole = 'preparation' | 'cooking' | 'texture' | 'assembly' | 'packing' | 'setting' | 'presentation' | 'method';
export type StepPhotoPlan = {
  stepId: string;
  index: number;
  required: boolean;
  reason: 'visible-method' | 'finished-presentation' | 'passive-wait';
  role: StepPhotoRole;
  objective: string;
  framing: string;
};

const normalise = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/ł/gu, 'l').toLowerCase();

// Only clear, low-information instructions are optional. Unknown methods stay
// required; a serving title must never hide cooking, shaping or a doneness test.
const presentation = /\b(?:serve|serving|plate|plating|garnish|finish with|divide between plates|ladle|scatter|sprinkle|drizzle|decorate|dust|podaj|podawaj|podanie|serwuj|udekoruj|posyp|skrop)\b/u;
const waiting = /\b(?:rest|leave|stand|cool|chill|refrigerate|odstaw|pozostaw|ostudz|schlodz|odpoczynek)\b/u;
const simpleWait = /^(?:leave|rest|stand|cool|chill|refrigerate|odstaw|pozostaw|ostudz|schlodz)(?:\s+(?:it|to|for|at|least|about|approximately|covered|uncovered|briefly|completely|in|the|fridge|refrigerator|room|temperature|minutes?|mins?|hours?|seconds?|przez|na|okolo|pod|przykryciem|bez|przykrycia|minut|minuty|godziny|godzin|\d+(?:[–-]\d+)?))*[.!]?$/u;
const visibleChange = /\b(?:cook|cooking|bake|baking|roast|roasting|fry|frying|toast|toasting|heat|heating|warming|simmer|simmering|boil|boiling|reduce|reducing|melt|melting|blend|blending|puree|whisk|whisking|beat|beating|knead|kneading|mix|mixing|stir|stirring|toss|tossing|shake|cut|slice|chop|grate|peel|crush|roll|seal|fold|shape|layer|pipe|fill|coat|press|strain|sieve|drain|rinse|wash|check|test|probe|thermometer|headspace|funnel|air bubbles|gotuj|ugotuj|piecz|upiecz|smaz|podsmaz|praz|podgrzej|zagotuj|redukuj|odparuj|rozpusc|zmiksuj|zblenduj|ubij|wyrabiaj|wymieszaj|mieszaj|wstrzasnij|pokroj|przekroj|posiekaj|zetrzyj|obierz|rozgniec|rozwalkuj|zlep|zloz|uformuj|warstw|napelnij|faszeruj|obtocz|docisnij|przecedz|odcedz|oplukaj|umyj|sprawdz|termometr|lejek)\b|\bwarm (?:the|it|gently|over|for|until)\b/u;
const settingCue = /\b(?:set|setting|firm|firmer|double|doubled|risen|rise|proof|thicken|thickens|thickened|wobble|wobbles|spring|springs|gel|zastygn|zetni|stwardn|wyros|podwoi|zgestni|sprezyst)\w*\b/u;
const structuralCue = /\b(?:mound|mounds|hollow|hollows|seam|seams|folding|sealing|rolling|piping|headspace|skin-side|cut-side|warstwy|zaglebi|zlepian|zwijani)\w*\b/u;
const presentationSentence = /^(?:serve|divide|arrange|ladle|spoon|scatter|sprinkle|drizzle|decorate|dust|finish|top|transfer|place|add|taste|season|podaj|podawaj|serwuj|udekoruj|posyp|skrop|rozloz|przeloz|naloz|dopraw)\b/u;
const packing = /\b(?:bottle|bottling|fill jars|fill and seal|headspace|funnel|air bubbles|hot filling|butelk|lejek)\w*\b/u;
const assembly = /\b(?:roll|seal|fold|shape|layer|pipe|fill|coat|press|sandwich|assemble|rozwalkuj|zlep|zloz|uformuj|warstw|napelnij|faszeruj|obtocz|docisnij)\b/u;
const preparation = /\b(?:cut|slice|chop|grate|peel|crush|rinse|wash|pokroj|przekroj|posiekaj|zetrzyj|obierz|rozgniec|oplukaj|umyj)\b/u;
const texture = /\b(?:blend|blending|puree|whisk|whisking|beat|beating|knead|kneading|mix|mixing|stir|stirring|toss|tossing|melt|melting|emuls|consistency|texture|coat|ribbon|stream|smooth|glossy|zmiksuj|zblenduj|ubij|wyrabiaj|wymieszaj|mieszaj|rozpusc|konsystenc|gladk|kremow)\w*\b/u;
const cooking = /\b(?:cook|cooking|bake|baking|roast|roasting|fry|frying|toast|toasting|heat|heating|warm|warming|simmer|simmering|boil|boiling|reduce|reducing|gotuj|ugotuj|piecz|upiecz|smaz|podsmaz|praz|podgrzej|zagotuj|redukuj|odparuj)\b/u;

function source(step: RecipeStep) {
  // The full method is authoritative. Titles help identify an otherwise simple
  // serving instruction, but ingredient adjectives are not preparation verbs.
  return normalise(`${step.title.en || step.title.pl}. ${step.text.en || step.text.pl}`);
}

function plan(step: RecipeStep, index: number): StepPhotoPlan {
  const text = source(step);
  const title = normalise(step.title.en || step.title.pl);
  const body = normalise(step.text.en || step.text.pl);
  const stateChange = settingCue.test(body);
  const method = visibleChange.test(body) || structuralCue.test(body);
  const presentationOnly = body.split(/[.!?]+/u).map(item => item.trim()).filter(Boolean).every(item => presentationSentence.test(item));
  const optionalPresentation = presentation.test(text) && presentationOnly && !method && !stateChange;
  const passiveWait = !optionalPresentation && waiting.test(text) && simpleWait.test(body.trim()) && !method && !stateChange;
  const role: StepPhotoRole = optionalPresentation ? 'presentation'
    : packing.test(title) || /\b(?:headspace|funnel|air bubbles|lejek)\b/u.test(body) ? 'packing'
      : assembly.test(title) ? 'assembly'
        : preparation.test(title) ? 'preparation'
          : texture.test(title) ? 'texture'
            : cooking.test(title) ? 'cooking'
              : assembly.test(body) ? 'assembly'
                : preparation.test(body) ? 'preparation'
                  : texture.test(body) ? 'texture'
                    : cooking.test(body) ? 'cooking'
              : stateChange ? 'setting' : 'method';
  const directions: Record<StepPhotoRole, [string, string]> = {
    preparation: ['Teach the specified cut, size or preparation of the current ingredient before later cooking or assembly.', 'Close view of the working surface and the current preparation; show a described tool in use only when it clarifies the technique.'],
    cooking: ['Teach the current cooking action or the exact doneness checkpoint stated in this step.', 'Close view inside the working cookware, exposing the surface or interior used to judge readiness; no finished serving arrangement.'],
    texture: ['Teach the current transformation and its stated texture or consistency; keep the food in its working vessel.', 'Close view of the mixture and a described stirring, pouring or testing action when useful; make its texture readable, without final plating.'],
    assembly: ['Teach the specific assembly, shape, seal, layers or coating in this step.', 'Show one unit during the decisive assembly action and enough surrounding structure to explain it; avoid a platter of completed servings.'],
    packing: ['Teach the filling or packing operation and the stated fill level, headspace or closure.', 'Close view during the operation, with the relevant opening and contents visible; not another photograph of the closed finished container.'],
    setting: ['Teach the visible criterion that shows the resting, cooling or setting stage is complete.', 'Close view of the stated set, rise or firmness checkpoint in the original vessel; do not substitute a generic waiting scene.'],
    presentation: ['A separate photograph is optional: this instruction adds no distinct visible method beyond the finished hero.', 'If the editor explicitly requests this photograph, show only the described serving motion or useful serving detail; avoid a second static beauty shot.'],
    method: ['Teach the decisive action or visible completion cue of this exact step.', 'Frame the working area and relevant food state closely enough to explain the method; no decorative finished-dish arrangement.'],
  };
  const [defaultObjective, framing] = directions[role];
  let objective = defaultObjective;
  if (role === 'texture' && /\b(?:blend|blending|puree|zmiksuj|zblenduj)\b/u.test(text)) {
    objective = 'Teach the blending operation and the change from the preceding pieces to the smoothness required here; show the described blender at work, not plated food.';
  } else if (role === 'texture' && /\b(?:melt|melting|rozpusc)\b/u.test(text)) {
    objective = 'Teach the stated melting or incorporation action while the added ingredient is joining the base. A ladle of unchanged finished food does not demonstrate this action.';
  } else if (role === 'texture' && /\b(?:toss|tossing|combine|wymieszaj)\b/u.test(text)) {
    objective = 'Teach the stated combining or tossing action and how the components become evenly coated; show the working mixture during that action, not a plated serving.';
  } else if (role === 'cooking' && /\b(?:cut|slice)\b[^.]{0,100}\b(?:half|centre|center|inside)\b/u.test(body)) {
    objective = 'Teach the stated doneness check by exposing the specified interior. Show that test on one piece in its working context, not a ladle or plate of the finished dish.';
  }
  return { stepId: step.id, index, required: !optionalPresentation && !passiveWait,
    reason: optionalPresentation ? 'finished-presentation' : passiveWait ? 'passive-wait' : 'visible-method', role, objective,
    framing: passiveWait ? 'A passive wait has no separate visual teaching objective; use the preceding checkpoint and finished hero instead.' : framing };
}

/** Photo coverage follows useful method evidence, never an arbitrary step quota. */
export function planStepPhotos(recipe: Pick<Recipe, 'steps'>): StepPhotoPlan[] {
  return recipe.steps.map(plan);
}

export function stepPhotoPlan(recipe: Pick<Recipe, 'steps'>, stepId: string): StepPhotoPlan | null {
  const index = recipe.steps.findIndex(step => step.id === stepId);
  return index < 0 ? null : plan(recipe.steps[index], index);
}
