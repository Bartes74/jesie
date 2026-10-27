'use client';

import { useId } from 'react';
import type { Recipe, Locale } from '@/lib/recipes';
import type { HeroPresentationReview } from '@/lib/hero-presentation-review';
import { heroPresentationContainers } from '@/components/admin/HeroPresentationFields';

type Props = {
  recipe: Recipe;
  value: HeroPresentationReview | null;
  locale: Locale;
  disabled: boolean;
  onChange: (presentation: HeroPresentationReview) => void;
};

/** The generated vessel and photo description are part of the same content review. */
export function RecipeHeroPresentationEditor({ recipe, value, locale, disabled, onChange }: Props) {
  const id = useId();
  const appearance = value?.finalAppearance ?? { pl: recipe.description.pl, en: recipe.description.en };
  return <section className="guided-review-note guided-hero-presentation" id="guided-hero-presentation" aria-labelledby={id + '-heading'}>
    <h3 id={id + '-heading'}>Zdjęcie gotowej potrawy</h3>
    <p>Sprawdź proponowane naczynie i opis zdjęcia. Możesz je zmienić przed zaakceptowaniem treści.</p>
    <fieldset className="guided-photo-fields" disabled={disabled}>
      <label className="admin-field" htmlFor={id + '-container'}>Naczynie
        <select id={id + '-container'} value={value?.container ?? ''} onChange={event => onChange({ container: event.target.value as HeroPresentationReview['container'], finalAppearance: appearance })}>
          <option value="" disabled>Wybierz naczynie…</option>
          {heroPresentationContainers.map(container => <option key={container.value} value={container.value}>{container.label}</option>)}
        </select>
      </label>
      <label className="admin-field" htmlFor={id + '-description'}>Opis zdjęcia gotowej potrawy ({locale === 'pl' ? 'PL' : 'EN · UK'})
        <textarea id={id + '-description'} rows={3} maxLength={600} value={appearance[locale]} disabled={!value} onChange={event => { if (value) onChange({ ...value, finalAppearance: { ...appearance, [locale]: event.target.value } }); }} />
      </label>
    </fieldset>
  </section>;
}
