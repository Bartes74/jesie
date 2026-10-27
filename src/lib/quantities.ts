import { formatRecipeDurationText } from './recipe-duration-text';
import Decimal from "decimal.js";
import type { Ingredient, IngredientAmount, IngredientUnit, Locale, Recipe, RecipeStep, UnitSystem } from "./recipes";

// Isolated configuration keeps third-party Decimal users from changing our arithmetic.
const QuantityDecimal = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

export const UNIT_CONVERSION_VERSION = "imperial-r1";
export const CONVERSION_CONSTANTS = Object.freeze({
  gramsPerOunce: "28.349523125",
  gramsPerPound: "453.59237",
  millilitresPerImperialFluidOunce: "28.4130625",
  millilitresPerImperialPint: "568.26125",
  millilitresPerImperialGallon: "4546.09",
  millilitresPerTeaspoon: "5",
  millilitresPerTablespoon: "15",
  millimetresPerInch: "25.4",
});

function positiveDecimal(value: string | number, field: string): Decimal {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError(`${field} must be a finite positive number`);
  }
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new RangeError(`${field} must be a positive decimal string`);
  }
  const decimal = new QuantityDecimal(value);
  if (!decimal.isFinite() || !decimal.gt(0)) {
    throw new RangeError(`${field} must be a finite positive number`);
  }
  return decimal;
}

/** Always scales immutable base amounts; no formatted value is used as input. */
export function scaleIngredientAmount(
  ingredient: Ingredient,
  baseServings: number,
  targetServings: number,
): IngredientAmount {
  const base = positiveDecimal(baseServings, "baseServings");
  const target = positiveDecimal(targetServings, "targetServings");
  if (ingredient.amount.kind === "qualitative") return ingredient.amount;
  const scale = (value: Decimal) => ingredient.scaling === "fixed" ? value : value.mul(target).div(base);
  if (ingredient.amount.kind === "exact") {
    return {
      ...ingredient.amount,
      value: scale(positiveDecimal(ingredient.amount.value, "amount")).toString(),
    };
  }
  const min = positiveDecimal(ingredient.amount.min, "range minimum");
  const max = positiveDecimal(ingredient.amount.max, "range maximum");
  if (max.lt(min)) throw new RangeError("range maximum must not be less than its minimum");
  return { ...ingredient.amount, min: scale(min).toString(), max: scale(max).toString() };
}

export function convertToImperial(value: string, unit: "g" | "ml"): string {
  const divisor = unit === "g" ? CONVERSION_CONSTANTS.gramsPerOunce : CONVERSION_CONSTANTS.millilitresPerImperialFluidOunce;
  return positiveDecimal(value, "amount").div(divisor).toString();
}

type DisplayValue = { text: string; rounded: Decimal; isApproximate: boolean };

function numericDisplay(value: Decimal, unit: IngredientUnit | "oz" | "fl oz", locale: Locale, minimumPlaces = 0): DisplayValue {
  let places = unit === "g" || unit === "ml" ? (value.gte(10) ? 0 : value.gte(1) ? 1 : 2) : 2;
  places = Math.max(places, minimumPlaces);
  let rounded = value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  // A dose must stay positive and its presentation error must be at most 1%.
  while (rounded.isZero() || rounded.minus(value).abs().div(value).gt("0.01")) {
    places += 1;
    rounded = value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  }
  const text = locale === "pl" ? rounded.toFixed().replace(".", ",") : rounded.toFixed();
  return { text, rounded, isApproximate: !rounded.eq(value) };
}

const fractions = [
  { numerator: 1, denominator: 2, glyph: "½" },
  { numerator: 1, denominator: 3, glyph: "⅓" },
  { numerator: 2, denominator: 3, glyph: "⅔" },
  { numerator: 1, denominator: 4, glyph: "¼" },
  { numerator: 3, denominator: 4, glyph: "¾" },
  { numerator: 1, denominator: 8, glyph: "⅛" },
  { numerator: 3, denominator: 8, glyph: "⅜" },
  { numerator: 5, denominator: 8, glyph: "⅝" },
  { numerator: 7, denominator: 8, glyph: "⅞" },
];

function fractionDisplay(value: Decimal, locale: Locale): DisplayValue {
  const whole = value.floor();
  const remainder = value.minus(whole);
  if (remainder.isZero()) return { text: whole.toFixed(), rounded: value, isApproximate: false };
  for (const fraction of fractions) {
    const fractionValue = new QuantityDecimal(fraction.numerator).div(fraction.denominator);
    // Decimal division of recurring fractions has finite precision, so compare
    // well below any representable culinary amount rather than rounding to quarters.
    if (remainder.minus(fractionValue).abs().lt("1e-50")) {
      return { text: `${whole.isZero() ? "" : `${whole.toFixed()} `}${fraction.glyph}`, rounded: value, isApproximate: false };
    }
  }
  return numericDisplay(value, null, locale);
}

function unitLabel(unit: IngredientUnit | "oz" | "fl oz", locale: Locale, amount: Decimal): string {
  if (unit === "count") return locale === "pl" ? "szt." : "pcs";
  if (unit === "tsp" || unit === "tbsp") {
    if (locale === "en") return unit;
    const forms = unit === "tsp" ? ["łyżeczka", "łyżeczki", "łyżeczek"] : ["łyżka", "łyżki", "łyżek"];
    if (amount.eq(1)) return forms[0];
    if (!amount.isInteger()) return forms[1];
    const lastDigit = amount.mod(10).toNumber();
    const lastTwoDigits = amount.mod(100).toNumber();
    return lastDigit >= 2 && lastDigit <= 4 && !(lastTwoDigits >= 12 && lastTwoDigits <= 14) ? forms[1] : forms[2];
  }
  if (unit === "fl oz") return "Imperial fl oz";
  return unit ?? "";
}

/** Common presentation for ingredient lists, step tokens, shopping lists and print. */
export function formatIngredientAmount(
  ingredient: Ingredient,
  baseServings: number,
  targetServings: number,
  unitSystem: UnitSystem,
  locale: Locale,
): string {
  const amount = scaleIngredientAmount(ingredient, baseServings, targetServings);
  if (amount.kind === "qualitative") return amount.text[locale];
  const converted = unitSystem === "uk" && (ingredient.unit === "g" || ingredient.unit === "ml");
  const unit = converted ? (ingredient.unit === "g" ? "oz" : "fl oz") : ingredient.unit;
  const values = amount.kind === "exact" ? [amount.value] : [amount.min, amount.max];
  const decimals = values.map((value) => new QuantityDecimal(converted ? convertToImperial(value, ingredient.unit as "g" | "ml") : value));
  const asFraction = unit === "count" || unit === "tsp" || unit === "tbsp";
  let displays = decimals.map((value) => asFraction ? fractionDisplay(value, locale) : numericDisplay(value, unit, locale));
  // A non-zero range must never disappear into one rounded value.
  if (decimals.length === 2 && !decimals[0].eq(decimals[1])) {
    let places = 2;
    while (displays[0].rounded.eq(displays[1].rounded)) {
      displays = decimals.map((value) => numericDisplay(value, unit, locale, places));
      places += 1;
    }
  }
  const prefix = amount.approximate ? (locale === "pl" ? "około " : "about ") : displays.some((display) => display.isApproximate) ? "≈ " : "";
  const label = unitLabel(unit, locale, decimals[decimals.length - 1]);
  return `${prefix}${displays.map((display) => display.text).join("–")}${label ? ` ${label}` : ""}`;
}

export function renderStepText(
  step: RecipeStep,
  recipe: Pick<Recipe, "ingredients" | "baseServings">,
  servings: number,
  units: UnitSystem,
  locale: Locale,
): string {
  const rendered = step.text[locale].replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_, ingredientId: string) => {
    const ingredient = recipe.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) throw new Error(`Unknown ingredient token ${ingredientId} in step ${step.id}`);
    return formatIngredientAmount(ingredient, recipe.baseServings, servings, units, locale);
  });
  return formatRecipeDurationText(rendered, locale);
}
