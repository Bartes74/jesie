import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { categories, findRecipe, getRecipeHref, recipes, type Ingredient, type RecipeStep } from "./recipes";
import { CONVERSION_CONSTANTS, convertToImperial, formatIngredientAmount, renderStepText, scaleIngredientAmount } from "./quantities";
import { getIngredientImage, getStepImage } from "./recipe-media";

test("every ingredient and cooking step has a correctly indexed photograph and bilingual cue", () => {
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const image = getIngredientImage(recipe.id, ingredient.id);
      assert.ok(image.index >= 0 && image.index < image.columns * image.rows);
      assert.ok(image.alt.pl && image.alt.en);
    }
    for (const step of recipe.steps) {
      const image = getStepImage(recipe.id, step.id);
      assert.ok(image.index >= 0 && image.index < image.columns * image.rows);
      assert.ok(image.caption?.pl && image.caption?.en);
    }
  }
});

const flour: Ingredient = {
  id: "flour",
  name: { pl: "mąka", en: "flour" },
  amount: { kind: "exact", value: "250" },
  unit: "g",
  scaling: "linear",
  group: { pl: "Ciasto", en: "Dough" },
};

test("the same immutable base is used for 4 → 7 → 4 portions", () => {
  assert.equal(formatIngredientAmount(flour, 4, 4, "metric", "pl"), "250 g");
  assert.equal(formatIngredientAmount(flour, 4, 7, "metric", "pl"), "≈ 438 g");
  assert.equal(formatIngredientAmount(flour, 4, 4, "metric", "pl"), "250 g");
  assert.deepEqual(flour.amount, { kind: "exact", value: "250" });
  assert.deepEqual(scaleIngredientAmount(flour, 4, 7), { kind: "exact", value: "437.5" });
  assert.equal(formatIngredientAmount(flour, 4, 6, "metric", "en"), "375 g");
  assert.deepEqual(scaleIngredientAmount({ ...flour, amount: { kind: "exact", value: "3" } }, 3, 1), { kind: "exact", value: "1" });
});

test("ranges scale both ends and qualitative amounts stay qualitative", () => {
  const juice: Ingredient = { ...flour, amount: { kind: "range", min: "20", max: "30" }, unit: "ml" };
  assert.equal(formatIngredientAmount(juice, 4, 2, "metric", "pl"), "10–15 ml");
  const salt: Ingredient = { ...flour, amount: { kind: "qualitative", text: { pl: "do smaku", en: "to taste" } }, unit: null };
  assert.equal(formatIngredientAmount(salt, 4, 24, "uk", "pl"), "do smaku");
  assert.equal(formatIngredientAmount(salt, 4, 1, "metric", "en"), "to taste");
});

test("fixed pan oil stays fixed instead of scaling with the batter", () => {
  const oil: Ingredient = { ...flour, amount: { kind: "exact", value: "10" }, unit: "ml", scaling: "fixed" };
  assert.equal(formatIngredientAmount(oil, 4, 1, "metric", "en"), "10 ml");
  assert.equal(formatIngredientAmount(oil, 4, 24, "metric", "pl"), "10 ml");
});

test("fractional eggs and measures remain explicit without rounding to whole items", () => {
  const eggs: Ingredient = { ...flour, amount: { kind: "exact", value: "2" }, unit: "count" };
  assert.equal(formatIngredientAmount(eggs, 4, 1, "metric", "pl"), "½ szt.");
  assert.equal(formatIngredientAmount(eggs, 4, 7, "uk", "en"), "3 ½ pcs");
  assert.equal(formatIngredientAmount({ ...eggs, amount: { kind: "exact", value: "1" } }, 3, 1, "metric", "en"), "⅓ pcs");
  assert.equal(formatIngredientAmount({ ...eggs, amount: { kind: "exact", value: "1" } }, 8, 1, "metric", "pl"), "⅛ szt.");
  const powder: Ingredient = { ...eggs, amount: { kind: "exact", value: "1" }, unit: "tsp" };
  assert.equal(formatIngredientAmount(powder, 4, 4, "metric", "pl"), "1 łyżeczka");
  assert.equal(formatIngredientAmount(powder, 4, 2, "uk", "pl"), "½ łyżeczki");
  assert.equal(formatIngredientAmount(powder, 4, 8, "uk", "en"), "2 tsp");
});

test("Imperial factors are decimal constants with no US fluid ounce substitution", () => {
  assert.equal(convertToImperial(CONVERSION_CONSTANTS.gramsPerOunce, "g"), "1");
  assert.equal(convertToImperial(CONVERSION_CONSTANTS.gramsPerPound, "g"), "16");
  assert.equal(convertToImperial(CONVERSION_CONSTANTS.millilitresPerImperialFluidOunce, "ml"), "1");
  assert.equal(convertToImperial(CONVERSION_CONSTANTS.millilitresPerImperialPint, "ml"), "20");
  assert.equal(convertToImperial(CONVERSION_CONSTANTS.millilitresPerImperialGallon, "ml"), "160");
  assert.equal(new Decimal(CONVERSION_CONSTANTS.millilitresPerImperialPint).div(CONVERSION_CONSTANTS.millilitresPerImperialFluidOunce).toString(), "20");
  assert.equal(formatIngredientAmount({ ...flour, amount: { kind: "exact", value: "568.26125" }, unit: "ml" }, 4, 4, "uk", "en"), "20 Imperial fl oz");
  assert.equal(formatIngredientAmount(flour, 4, 4, "uk", "en"), "≈ 8.82 oz");
});

test("round-half-up is presentation only and adjusts precision for tiny doses", () => {
  assert.equal(formatIngredientAmount({ ...flour, amount: { kind: "exact", value: "12.5" } }, 1, 1, "metric", "en"), "12.5 g");
  // 12.5 → 13 exceeds the 1% presentation tolerance, so retain one decimal.
  assert.equal(formatIngredientAmount({ ...flour, amount: { kind: "exact", value: "100.5" } }, 1, 1, "metric", "en"), "≈ 101 g");
  assert.equal(formatIngredientAmount({ ...flour, amount: { kind: "exact", value: "0.3" } }, 4, 4, "metric", "pl"), "0,3 g");
  const tiny = formatIngredientAmount({ ...flour, amount: { kind: "exact", value: "0.000003" } }, 1, 1, "uk", "en");
  const shown = new Decimal(tiny.replace("≈ ", "").replace(" oz", ""));
  assert.ok(shown.gt(0));
  const actual = new Decimal(convertToImperial("0.000003", "g"));
  assert.ok(shown.minus(actual).abs().div(actual).lte("0.01"));
});

test("narrow ranges retain different displayed bounds", () => {
  const range: Ingredient = { ...flour, amount: { kind: "range", min: "100.01", max: "100.02" } };
  assert.equal(formatIngredientAmount(range, 1, 1, "metric", "en"), "100.01–100.02 g");
});

test("explicit approximation and decimal separators remain localised", () => {
  const approximate: Ingredient = { ...flour, amount: { kind: "exact", value: "100", approximate: true } };
  assert.equal(formatIngredientAmount(approximate, 1, 2, "metric", "pl"), "około 200 g");
  assert.equal(formatIngredientAmount(approximate, 1, 2, "metric", "en"), "about 200 g");
  assert.equal(formatIngredientAmount({ ...flour, amount: { kind: "exact", value: "2.5" } }, 1, 1, "metric", "pl"), "2,5 g");
});

test("step tokens share the list calculator while temperatures and timers stay fixed", () => {
  const recipe = recipes[0];
  const pastaStep = recipe.steps.find((item) => item.id === "pasta")!;
  assert.ok(renderStepText(pastaStep, recipe, 6, "metric", "pl").includes("600 g"));
  assert.ok(renderStepText(pastaStep, recipe, 6, "uk", "en").includes("≈ 21.16 oz"));
  const cake = recipes.find((item) => item.id === "apple-cake")!;
  const ovenStep = cake.steps.find((item) => item.id === "assemble")!;
  assert.ok(renderStepText(ovenStep, cake, 16, "metric", "pl").includes("180 °C"));
  assert.equal(cake.steps.find((item) => item.id === "bake")!.timerMinutes, 40);
  const broken: RecipeStep = { id: "broken", title: { pl: "", en: "" }, text: { pl: "{{missing}}", en: "{{missing}}" } };
  assert.throws(() => renderStepText(broken, recipe, 4, "metric", "pl"), /Unknown ingredient token/);
});

test("invalid quantities and portion counts cannot silently produce NaN or zero", () => {
  for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatIngredientAmount(flour, 4, target, "metric", "en"), RangeError);
  }
  assert.throws(() => scaleIngredientAmount(flour, 0, 4), RangeError);
  for (const value of ["0", "-1", "NaN", "1e3", "2,5", ""]) {
    assert.throws(() => formatIngredientAmount({ ...flour, amount: { kind: "exact", value } }, 4, 4, "metric", "en"), RangeError);
  }
  assert.throws(() => scaleIngredientAmount({ ...flour, amount: { kind: "range", min: "30", max: "20" } }, 4, 4), RangeError);
});

test("all demo recipes have both languages, known categories and resolvable step links", () => {
  assert.equal(categories.length, 10);
  assert.equal(recipes.length, 6);
  for (const recipe of recipes) {
    assert.equal(recipe.provenance.type, "demo_ai");
    assert.equal(recipe.provenance.kitchenTested, false);
    assert.ok(recipe.categories.includes(recipe.primaryCategory));
    assert.ok(recipe.categories.every((id) => categories.some((category) => category.id === id)));
    assert.equal(new Set(recipe.ingredients.map((ingredient) => ingredient.id)).size, recipe.ingredients.length);
    assert.ok(recipe.dietaryTags.every((tag) => tag.status === "to_review"));
    for (const locale of ["pl", "en"] as const) {
      assert.equal(findRecipe(locale, recipe.slug[locale])?.id, recipe.id);
      assert.equal(getRecipeHref(recipe, locale), `/${locale}/recipes/${recipe.slug[locale]}`);
      assert.ok(recipe.title[locale] && recipe.description[locale] && recipe.imageAlt[locale] && recipe.storage[locale]);
      for (const ingredient of recipe.ingredients) {
        assert.ok(ingredient.name[locale] && ingredient.group[locale]);
        for (const units of ["metric", "uk"] as const) {
          assert.ok(formatIngredientAmount(ingredient, recipe.baseServings, 1, units, locale));
        }
      }
      for (const item of recipe.steps) {
        assert.ok(item.title[locale]);
        assert.ok(!renderStepText(item, recipe, 7, "uk", locale).includes("{{"));
      }
    }
  }
  assert.equal(findRecipe("pl", "missing"), undefined);
});
