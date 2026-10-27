import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Ingredient } from '@/lib/recipes';
import { unrecognisedRecipeIngredientNames, type VerifiedIngredientDictionary } from '@/lib/recipe-diet';

const ingredient = (name: string, note?: Ingredient['note']): Ingredient => ({
  id: 'ingredient', name: { pl: name, en: name }, note,
  amount: { kind: 'exact', value: '1' }, unit: 'g', scaling: 'linear', group: { pl: '', en: '' },
});

function harness() {
  const reads: { names: readonly string[]; db: unknown }[] = [];
  const dictionary: VerifiedIngredientDictionary = new Map([['biltong', 'meat']]);
  const imports: Record<string, unknown> = {
    'server-only': {},
    '@/lib/recipe-diet': { unrecognisedRecipeIngredientNames },
    './ingredient-dictionary-store': { lookupExactAliases: async (names: readonly string[], db: unknown) => {
      reads.push({ names, db }); return dictionary;
    } },
  };
  const exports: Partial<typeof import('./recipe-ingredient-dictionary')> = {};
  const code = ts.transpileModule(readFileSync(new URL('./recipe-ingredient-dictionary.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { exports, require: (name: string) => {
    assert(Object.hasOwn(imports, name), name); return imports[name];
  }, Map });
  return { read: exports.getRecipeVerifiedAliases!, reads, dictionary };
}

test('known recipes need no dictionary database while an unknown animal keeps its evidence through a dairy note', async () => {
  const h = harness(), transaction = { transaction: 'current' };
  const known = await h.read([ingredient('carrot'), ingredient('cream')], transaction as never);
  assert.equal(known.size, 0);
  assert.equal(h.reads.length, 0);
  const aliases = await h.read([ingredient('biltong', { pl: '', en: 'Contains cream.' }), ingredient('cream')], transaction as never);
  assert.equal(aliases, h.dictionary);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.reads[0].names, ['biltong']);
  assert.equal(h.reads[0].db, transaction);
});
