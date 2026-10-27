import type { Locale } from "./recipes";

export function formatServingCount(count: number, locale: Locale): string {
  if (locale === "en") return `${count} ${count === 1 ? "serving" : "servings"}`;
  const ending = count % 10;
  const teen = count % 100;
  return `${count} ${count === 1 ? "porcja" : ending >= 2 && ending <= 4 && !(teen >= 12 && teen <= 14) ? "porcje" : "porcji"}`;
}
