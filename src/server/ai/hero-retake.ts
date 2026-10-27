export type HeroRetakeVersion = 'vessel-cutout-v1' | 'complete-composition-v1';

// Only complete, simple dish/vessel directions opt into a vessel-only mask.
// Any additional prose may request detached objects or a serving surface, so
// unfamiliar free-form instructions retain their complete composition.
const polishSubject = '(?:(?:gotow(?:a|ą|ej) )?potraw(?:a|ę|y)|(?:gotow(?:e|ego) )?dani(?:e|a)|gotow(?:y|ego) sos(?:u)?|gotow(?:y|ego) produkt(?:u)?|gotowy przetwór)';
const polishVessel = '(?:na|w|we) (?:(?:jednym|prostym|małym|dużym|ceramicznym|szklanym|glinianym|żeliwnym|żaroodpornym|okrągłym) ){0,3}(?:talerzu|misce|sosjerce|słoiku|butelce|szklance|kieliszku|garnku|patelni|półmisku|naczyniu(?: żaroodpornym)?)';
const englishSubject = '(?:(?:a|the) )?(?:(?:finished|prepared|completed) )?(?:dish|food|meal|sauce|product|preserve)';
const englishVessel = '(?:on|in) (?:(?:a|the|one) )?(?:(?:simple|small|large|original|ceramic|glass|clay|earthenware|cooking|frying|baking|serving|round) ){0,3}(?:plate|bowl|sauce boat|jar|bottle|glass|goblet|tumbler|pot|pan|skillet|platter|baking dish|casserole dish)';
const simplePolishBrief = new RegExp(`^(?:(?:podaj|pokaż|przedstaw|sfotografuj) )?(?:(?:zdjęcie|fotografia|fotografię) )?${polishSubject}(?: ${polishVessel})?$`, 'iu');
const simpleEnglishBrief = new RegExp(`^(?:(?:show|serve|present|photograph) )?(?:(?:photo|photograph) of )?${englishSubject}(?: ${englishVessel})?(?: (?:photo|photograph))?$`, 'iu');
const simpleVesselBrief = new RegExp(`^(?:${polishVessel}|${englishVessel})$`, 'iu');

export function heroRetakeVersionForBrief(brief: string): HeroRetakeVersion {
  const instruction = brief.trim().replace(/\s+/gu, ' ').replace(/[.!?]+$/u, '').trim();
  return instruction.length <= 400 && [simplePolishBrief, simpleEnglishBrief, simpleVesselBrief].some(pattern => pattern.test(instruction))
    ? 'vessel-cutout-v1' : 'complete-composition-v1';
}

/** Classify historical captures too; regenerate alone does not mean props exist. */
export function isCompleteHeroComposition(regenerate: boolean | undefined, brief: string | undefined): boolean {
  return regenerate === true && (brief === undefined || heroRetakeVersionForBrief(brief) === 'complete-composition-v1');
}
