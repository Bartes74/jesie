import 'server-only';
import type { EditorialContent, SourceReference } from '@/lib/editorial-types';
import type { Ingredient } from '@/lib/recipes';
import { inspectRecipeDiet, unrecognisedRecipeIngredientNames, type RecipeDietId } from '@/lib/recipe-diet';
import { ingredientEvidencePolicyVersion, normalizeIngredientVerificationName, type IngredientVerificationInput, type IngredientVerificationResult } from '@/lib/ingredient-verification';
import { capturedRecipeProposalSchema } from './recipe-proposal';
import { ProviderError } from './provider-error';
import type { RecipeIngredientResolution } from './text-provider';

type Verification = {
  key: string; input: IngredientVerificationInput; status: string; providerRequestId: string | null;
  result: IngredientVerificationResult | null; errorMessage?: string | null;
  claimToken?: string;
  learned?: boolean; errorCode?: string | null;
  eligibilityPolicyVersion?: string;
};
export type IngredientResolutionDependencies = {
  aliases(names: string[]): Promise<ReadonlyMap<string, RecipeDietId>>;
  find(input: IngredientVerificationInput): Promise<Verification | null>;
  checkPermission(): Promise<void>;
  claim(input: IngredientVerificationInput): Promise<{ verification: Verification; claimed: boolean; claimToken?: string }>;
  submit(input: IngredientVerificationInput, beforeSubmit: () => Promise<void>, key: string): Promise<string>;
  attach(key: string, token: string, receipt: string): Promise<unknown>;
  poll(receipt: string, input: IngredientVerificationInput): Promise<{ done: false } | { done: true; result: IngredientVerificationResult; cost: { chargedUsd?: string | null; costBasis?: 'usage' | 'reservation'; usage?: { inputTokens: number; outputTokens: number } | null } }>;
  complete(key: string, receipt: string, result: IngredientVerificationResult, cost: { chargedUsd?: string | null; costBasis?: 'usage' | 'reservation'; usage?: { inputTokens: number; outputTokens: number } | null }): Promise<Verification>;
  fail(row: Verification, token: string | undefined, error: ProviderError): Promise<unknown>;
  pending(name: string): Promise<void>;
};

function unknownBase(ingredient: Ingredient) {
  // A familiar word in a composition note cannot identify the unfamiliar base product.
  return unrecognisedRecipeIngredientNames([ingredient]).length > 0;
}

function evidence(result: IngredientVerificationResult, key: string): SourceReference[] {
  return result.sources.map((source, index) => ({ id: `ingredient_${key.slice(0, 20)}_${index}`,
    title: `Weryfikacja składnika ${result.queriedNames.pl || result.queriedNames.en}: ${source.title}`.slice(0, 500), url: source.url }));
}

function unresolved(ingredient: Ingredient, row?: Verification | null): ProviderError {
  const result = row?.result;
  const suggestion = result?.decision === 'possible_typo' && result.suggestedName
    ? ` Możliwa literówka; sprawdź nazwę „${result.suggestedName.pl || result.suggestedName.en}”. Oryginalny opis pozostaje bez zmian.` : '';
  const reason = row?.errorMessage || (result?.decision === 'verified' && !row?.learned
    ? `Nazwa istnieje, ale dowody nie spełniły warunków automatycznego wpisania do słownika. ${result.reason}`
    : result?.reason) || 'Nie udało się potwierdzić dokładnej nazwy i zastosowania kulinarnego w wymaganych źródłach.';
  const message = `${ingredient.name.pl || ingredient.name.en}: ${reason}${suggestion}`;
  return new ProviderError('AI_RESULT_INVALID', 'Sprawdzenie nieznanego składnika wymaga Twojej uwagi. Zachowano wygenerowany wynik przepisu.', false, undefined,
    { issues: [{ field: `ingredients.${ingredient.id}.name`, code: 'DIET_INGREDIENT_UNRECOGNISED', message }], repairable: false });
}

/** Re-check one retained recipe response; each unknown identity has at most one durable paid lookup. */
export function recipeIngredientResolver(input: EditorialContent, deps: IngredientResolutionDependencies) {
  return async (raw: unknown): Promise<RecipeIngredientResolution> => {
    const empty: RecipeIngredientResolution = { pending: false, dictionary: new Map(), notes: [], sources: [] };
    // Malformed recipe payloads must follow the normal validator, without buying research.
    const parsed = capturedRecipeProposalSchema(input).safeParse(raw);
    if (!parsed.success) return empty;
    const ingredients: Ingredient[] = parsed.data.ingredients.map(({ note, ...item }) => ({ ...item,
      ...(note ? { note } : {}) }));
    const candidates = ingredients.filter(unknownBase);
    if (!candidates.length) return empty;
    const allNames = candidates.flatMap(item => [item.name.pl, item.name.en]);
    let dictionary = await deps.aliases(allNames);
    const notes: string[] = [], sources: SourceReference[] = [];
    const seen = new Set<string>();
    for (const ingredient of candidates) {
      const query: IngredientVerificationInput = { name: ingredient.name };
      const identity = [ingredient.name.pl, ingredient.name.en].map(normalizeIngredientVerificationName).sort().join('|');
      if (seen.has(identity)) continue;
      seen.add(identity);
      const namesKnown = () => unrecognisedRecipeIngredientNames([ingredient]).every(name => dictionary.has(normalizeIngredientVerificationName(name)));
      let row = await deps.find(query);
      if (row?.errorCode === 'INGREDIENT_ALIAS_CONFLICT') {
        // Reconcile immutable, already-paid evidence locally. A former false
        // conflict must not purchase a fresh lookup or re-poll the provider.
        if (row.status === 'complete' && row.result?.autoLearnEligible && row.providerRequestId
          && row.eligibilityPolicyVersion === ingredientEvidencePolicyVersion) {
          try { row = await deps.complete(row.key, row.providerRequestId, row.result, {}); }
          catch {
            throw new ProviderError('AI_PROVIDER_STATUS_UNAVAILABLE', 'Nie udało się ponownie sprawdzić zapisanych dowodów składnika. Zachowano istniejący wynik; spróbuj odczytu ponownie.', true);
          }
        }
        if (row.errorCode === 'INGREDIENT_ALIAS_CONFLICT' || !row.learned) throw unresolved(ingredient, row);
      }
      // Another recipe's worker may have promoted this exact identity after
      // the first dictionary read and before the verification-row read.
      if (row?.status === 'complete' && row.learned) dictionary = await deps.aliases(allNames);
      const known = namesKnown();
      if (known) {
        if (row?.result?.autoLearnEligible && row.learned) {
          sources.push(...evidence(row.result, row.key));
          notes.push(`Potwierdzono składnik „${ingredient.name.pl || ingredient.name.en}” w źródłach; wykorzystano zapamiętaną weryfikację.`);
        }
        continue;
      }
      if (!row) {
        try { await deps.checkPermission(); }
        catch { throw unresolved(ingredient, { key: '', input: query, status: 'failed', providerRequestId: null, result: null,
          errorMessage: 'Szkic lub stan generowania zmienił się. Dodatkowa weryfikacja nie została wysłana.' }); }
        const claim = await deps.claim(query); row = claim.verification;
        if (claim.claimed && claim.claimToken) {
          await deps.pending(ingredient.name.pl || ingredient.name.en);
          try {
            const receipt = await deps.submit(row.input, async () => {
              try { await deps.checkPermission(); }
              catch { throw new ProviderError('AI_INGREDIENT_VERIFICATION_CANCELLED', 'Stan szkicu zmienił się przed wysłaniem sprawdzenia. Nie wysłano żądania.', false, '0'); }
            }, `ingredient-${row.key}`);
            await deps.attach(row.key, claim.claimToken, receipt);
            return { pending: true, dictionary, notes, sources };
          } catch (error) {
            const failure = error instanceof ProviderError ? error : new ProviderError('AI_INGREDIENT_VERIFICATION_SUBMISSION_UNCERTAIN', 'Nie potwierdzono wysłania sprawdzenia. Nie ponawiamy płatnego żądania.', true);
            await deps.fail(row, claim.claimToken, failure);
            throw unresolved(ingredient, { ...row, errorMessage: failure.message });
          }
        }
      }
      const recheck = row.status === 'complete' && !row.learned && row.result?.decision === 'verified'
        && row.eligibilityPolicyVersion !== ingredientEvidencePolicyVersion;
      if ((['generating', 'uncertain'].includes(row.status) || recheck) && row.providerRequestId) {
        await deps.pending(ingredient.name.pl || ingredient.name.en);
        try {
          const polled = await deps.poll(row.providerRequestId, row.input);
          if (!polled.done) return { pending: true, dictionary, notes, sources };
          row = await deps.complete(row.key, row.providerRequestId, polled.result, polled.cost);
          dictionary = await deps.aliases(allNames);
        } catch (error) {
          if (error instanceof ProviderError && error.code === 'AI_INGREDIENT_VERIFICATION_READ_UNAVAILABLE')
            throw new ProviderError('AI_PROVIDER_STATUS_UNAVAILABLE', error.message, true);
          const failure = error instanceof ProviderError ? error : new ProviderError('AI_INGREDIENT_VERIFICATION_INVALID', 'Nie zapisano potwierdzenia składnika. Zachowano zgłoszenie do sprawdzenia.', true);
          // A database write failure after a completed GET can be retried safely using the same receipt.
          if (!(error instanceof ProviderError)) throw new ProviderError('AI_PROVIDER_STATUS_UNAVAILABLE', failure.message, true);
          await deps.fail(row, undefined, failure);
          throw unresolved(ingredient, { ...row, errorMessage: failure.message });
        }
      }
      if (row.status === 'submitting') {
        await deps.pending(ingredient.name.pl || ingredient.name.en);
        // claim() expires an abandoned submit without ever submitting it again.
        await deps.claim(query);
        return { pending: true, dictionary, notes, sources };
      }
      if (!row.result?.autoLearnEligible || !row.learned || row.status !== 'complete' || row.errorCode === 'INGREDIENT_ALIAS_CONFLICT' || !namesKnown()
        || inspectRecipeDiet({ ingredients: [{ ...ingredient, note: undefined }] }, dictionary).uncertainIngredients.length) throw unresolved(ingredient, row);
      sources.push(...evidence(row.result, row.key));
      notes.push(`Potwierdzono składnik „${ingredient.name.pl || ingredient.name.en}” i zapisano jego dokładną nazwę w słowniku ze źródłami.`);
    }
    return { pending: false, dictionary, notes, sources };
  };
}

export async function resolveRecipeIngredients(job: { id: string; recipeId: string; input: EditorialContent }, raw: unknown) {
  const store = await import('./ingredient-dictionary-store');
  const provider = await import('./ingredient-verification-provider');
  const jobs = await import('./store');
  return recipeIngredientResolver(job.input, {
    aliases: names => store.lookupExactAliases(names),
    find: query => store.getVerification(store.ingredientVerificationKey(query)),
    checkPermission: () => jobs.ensureIngredientVerificationAllowed(job.id),
    claim: query => store.startOrClaimVerification(query, { originJobId: job.id, originRecipeId: job.recipeId }),
    submit: provider.submitIngredientVerification,
    attach: store.attachReceipt,
    poll: provider.pollIngredientVerification,
    complete: store.completeVerification,
    fail: (row, token, error) => {
      const owner = token ?? row.claimToken;
      if (!owner) throw new Error('INGREDIENT_VERIFICATION_CLAIM_REQUIRED');
      const cost = error.chargedUsd !== undefined ? { chargedUsd: error.chargedUsd, costBasis: 'usage' as const }
        : !row.providerRequestId && !error.uncertain ? { chargedUsd: '0', costBasis: 'usage' as const } : {};
      return error.uncertain
        ? store.markUncertain(row.key, owner, { code: error.code, message: error.message }, cost)
        : store.failVerification(row.key, owner, { code: error.code, message: error.message }, cost);
    },
    pending: name => jobs.markIngredientVerificationPending(job.id, name),
  })(raw);
}
