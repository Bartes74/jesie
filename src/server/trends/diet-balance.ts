import type { RecipeDietId } from '@/lib/recipe-diet';
import type { TrendDietCounts, TrendDietSelection } from '@/lib/trend-types';
import type { RawCandidate } from './ranking';
import { normaliseDish } from './ranking';

/** Actual current publications; recent also includes retained, prepared draft choices. */
export type TrendDietBalance = { catalog: RecipeDietId[]; recent: RecipeDietId[] };
export const dietBalanceRecentWindow = 12;
const labels = { meat: 'mięsne lub rybne', vegetarian: 'wegetariańskie', vegan: 'wegańskie' };

export function dietCounts(diets: RecipeDietId[]): TrendDietCounts {
    return diets.reduce((counts, diet) => { counts[diet]++; return counts; }, { meat: 0, vegetarian: 0, vegan: 0 });
}

/** Names can contradict a discovery hint, but never establish that an unknown dish is vegan. */
export function candidateDiet(candidate: Pick<RawCandidate, 'title' | 'diet'>): RecipeDietId | undefined {
    const name = normaliseDish(`${candidate.title.pl} ${candidate.title.en}`);
    const explicitlyPlantBased = /\b(?:vegan\w*|wegansk\w*|plant based)\b/.test(name);
    if (explicitlyPlantBased) return candidate.diet === 'vegan' ? 'vegan' : undefined;
    if (/\b(?:chicken|turkey|beef|pork|lamb|duck|bacon|ham|sausage|salmon|tuna|fish|cod|trout|herring|sardine\w*|shrimp|prawn|anchov\w*|kurczak\w*|indyk\w*|wolow\w*|wieprz\w*|jagn\w*|kaczk\w*|boczek|boczkiem|szynk\w*|kielbas\w*|losos\w*|tunczyk\w*|ryb\w*|krewet\w*|anchois|dorsz\w*|pstrag\w*|sledz\w*|sardyn\w*)\b/.test(name)) {
        return candidate.diet && candidate.diet !== 'meat' ? undefined : 'meat';
    }
    // Dairy/eggs/honey named in the title disqualify a vegan discovery claim.
    const animalProduct = /\b(?:eggs?|cheese|feta|burrata|ricotta|halloumi|parmesan|yogh?urt|honey|jaj\w*|ser|sera|serem|sery|serow\w*|masl\w*|butter|jogurt\w*|miod\w*)\b/.test(name.replace(/\b(?:masl\w* orzech\w*|peanut butter|almond butter|coconut butter|butter beans|egg free)\b/g, ''));
    if (animalProduct && candidate.diet === 'vegan') return undefined;
    if (/\b(?:parmesan|parmezan\w*|parmigiano|grana padano|pecorino|roquefort)\b/.test(name)
        && !/\b(?:vegetarian|wegetarians\w*)\b/.test(name)) return candidate.diet && candidate.diet !== 'meat' ? undefined : 'meat';
    return candidate.diet;
}

export function dietBalanceTarget(balance: TrendDietBalance): Omit<TrendDietSelection, 'selected' | 'fallback'> {
    const counts = dietCounts(balance.catalog);
    const recent = balance.recent.slice(0, dietBalanceRecentWindow);
    const recentCounts = dietCounts(recent);
    const plantCount = counts.vegetarian + counts.vegan;
    const recentPlant = recentCounts.vegetarian + recentCounts.vegan;
    // Aim for 50/25/25 in the catalogue. A short rolling guard prevents weeks of
    // one-sided catch-up after a historically uneven catalogue or rejected drafts.
    let meat = counts.meat <= plantCount;
    let rollingGuard = false;
    if (recent.length >= 4) {
        if (recentCounts.meat >= Math.ceil(recent.length * .6)) { meat = false; rollingGuard = true; }
        else if (recentPlant >= Math.ceil(recent.length * .6)) { meat = true; rollingGuard = true; }
    }
    let plant: RecipeDietId = counts.vegan <= counts.vegetarian ? 'vegan' : 'vegetarian';
    if (recentCounts.vegan > recentCounts.vegetarian + 1) plant = 'vegetarian';
    else if (recentCounts.vegetarian > recentCounts.vegan + 1) plant = 'vegan';
    const target = meat ? 'meat' : plant;
    return {
        target, counts, recentCounts, recentWindow: recent.length,
        reason: `Cel doboru: ${labels[target]}. Bieżący katalog: ${counts.meat} mięsnych lub rybnych, ${counts.vegetarian} wegetariańskich, ${counts.vegan} wegańskich. Dążymy do proporcji 50% / 25% / 25%.${rollingGuard ? ' Uwzględniono także ostatnie wybory, aby żadna grupa nie czekała na nowe przepisy przez długi okres wyrównywania katalogu.' : ''}`,
    };
}

export function dietSelection(balance: TrendDietBalance, selected: RecipeDietId | undefined): TrendDietSelection {
    const plan = dietBalanceTarget(balance);
    const fallback = selected !== plan.target;
    return {
        ...plan, selected: selected ?? null, fallback,
        reason: plan.reason + (fallback ? ' Brak nowej, bezpiecznej inspiracji z docelowej kategorii; wybrano dostępną potrawę bez zmieniania jej rzeczywistej kategorii ani ponawiania płatnego wyszukiwania.' : ''),
    };
}
