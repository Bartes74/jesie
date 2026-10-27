'use client';

import { useId, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Recipe } from '@/lib/recipes';
import { heroPresentationProfile, resolveHeroPresentationForBrief, suggestHeroPresentation, heroPresentationIssue, type HeroPresentation } from '@/lib/hero-presentation';

export const heroPresentationContainers: { value: HeroPresentation['container']; label: string; view: string }[] = [
  { value: 'plate', label: 'Talerz', view: 'Zdjęcie z góry, z całym brzegiem talerza.' },
  { value: 'bowl', label: 'Miska', view: 'Zdjęcie z góry, z całym brzegiem miski.' },
  { value: 'clay-pot', label: 'Gliniany garnek', view: 'Ujęcie lekko z góry pokazujące potrawę i całe gliniane naczynie.' },
  { value: 'pot', label: 'Garnek', view: 'Ujęcie lekko z góry pokazujące gotową potrawę w garnku.' },
  { value: 'pan', label: 'Patelnia', view: 'Ujęcie z góry, z całym brzegiem patelni i uchwytem.' },
  { value: 'baking-dish', label: 'Naczynie do zapiekania', view: 'Ujęcie lekko z góry pokazujące wierzch potrawy i całe naczynie.' },
  { value: 'platter', label: 'Półmisek', view: 'Zdjęcie z góry, z całym brzegiem półmiska.' },
  { value: 'sauceboat', label: 'Mała sosjerka', view: 'Ujęcie pod kątem pokazujące sos i kształt sosjerki.' },
  { value: 'jar', label: 'Szklany słoik', view: 'Ujęcie lekko z góry, z zawartością widoczną przez ścianki.' },
  { value: 'bottle', label: 'Szklana butelka', view: 'Ujęcie z boku i lekko z góry, z widoczną zawartością i zamknięciem.' },
  { value: 'glass', label: 'Szklanka lub kieliszek', view: 'Ujęcie pod kątem pokazujące szklane naczynie, zawartość i dodatki na wierzchu.' },
];

type Props = {
  recipe: Recipe;
  value?: HeroPresentation | null;
  onChange: (presentation: HeroPresentation) => void;
  disabled?: boolean;
};

export function HeroPresentationFields({ recipe, value, onChange, disabled = false }: Props) {
  const id = useId();
  const resolved = value === undefined ? resolveHeroPresentationForBrief(recipe, '') : value;
  const presentation: HeroPresentation = resolved ?? recipe.heroPresentation ?? {
    container: 'plate', finalAppearance: { pl: '', en: '' }, evidenceStepIds: [], profileVersion: heroPresentationProfile,
  };
  const suggestion = suggestHeroPresentation(recipe);
  const issue = heroPresentationIssue(recipe, resolved ?? recipe.heroPresentation);
  const hasContainer = Boolean(resolved || recipe.heroPresentation);
  const change = (updates: Partial<HeroPresentation>) => onChange({ ...presentation, ...updates, profileVersion: heroPresentationProfile });
  const selectedContainer = heroPresentationContainers.find(container => container.value === presentation.container);
  const currentStepIds = new Set(recipe.steps.map(step => step.id));
  const outdatedEvidence = presentation.evidenceStepIds.some(stepId => !currentStepIds.has(stepId));
  const [evidenceOpen, setEvidenceOpen] = useState(() => presentation.evidenceStepIds.length === 0 || outdatedEvidence);

  return <fieldset className="admin-hero-presentation" disabled={disabled}>
    <legend>Zdjęcie gotowej potrawy</legend>
    <p className="admin-subtle">Dobierz naczynie i wygląd na podstawie całego przepisu, łącznie z dekoracją oraz ostatnim krokiem przygotowania.</p>
    <label className="admin-field" htmlFor={id + '-container'}>Naczynie
      <select id={id + '-container'} value={hasContainer ? presentation.container : ''} onChange={event => change({ container: event.target.value as HeroPresentation['container'] })} aria-describedby={id + '-view'}>
        <option value="" disabled>Wybierz naczynie…</option>
        {heroPresentationContainers.map(container => <option key={container.value} value={container.value}>{container.label}</option>)}
      </select>
      <small id={id + '-view'}>{hasContainer ? selectedContainer?.view : 'Najpierw dobierz naczynie na podstawie przygotowania potrawy.'}</small>
    </label>
    <div className="admin-field-grid">
      <label className="admin-field" htmlFor={id + '-pl'}>Wygląd gotowej potrawy (PL)
        <textarea id={id + '-pl'} rows={3} maxLength={600} disabled={!hasContainer} value={presentation.finalAppearance.pl} onChange={event => change({ finalAppearance: { ...presentation.finalAppearance, pl: event.target.value } })} placeholder="Np. gładki żółty sos, bez widocznych kawałków gruszki." />
      </label>
      <label className="admin-field" htmlFor={id + '-en'}>Wygląd gotowej potrawy (EN · UK)
        <textarea id={id + '-en'} rows={3} maxLength={600} disabled={!hasContainer} value={presentation.finalAppearance.en} onChange={event => change({ finalAppearance: { ...presentation.finalAppearance, en: event.target.value } })} placeholder="For example: a smooth yellow sauce with no visible pieces of pear." />
      </label>
    </div>
    <details className="admin-hero-evidence" open={evidenceOpen} onToggle={event => setEvidenceOpen(event.currentTarget.open)}>
      <summary>Kroki określające końcowy wygląd ({presentation.evidenceStepIds.length})</summary>
      <p className="admin-subtle">Wybierz kroki, które opisują końcową konsystencję lub przekładanie do naczynia.</p>
      {recipe.steps.length === 0 ? <p className="admin-inline-error">Najpierw dodaj kroki przygotowania.</p> : recipe.steps.map((step, index) => <label className="admin-checkbox" key={step.id}>
        <input type="checkbox" disabled={!hasContainer} checked={presentation.evidenceStepIds.includes(step.id)} onChange={event => change({ evidenceStepIds: event.target.checked ? [...presentation.evidenceStepIds, step.id] : presentation.evidenceStepIds.filter(stepId => stepId !== step.id) })} />
        <span>{index + 1}. {step.title.pl || step.title.en || 'Bez tytułu'}</span>
      </label>)}
      {outdatedEvidence && <button type="button" className="admin-text-link admin-ai-inline-button" onClick={() => change({ evidenceStepIds: presentation.evidenceStepIds.filter(stepId => currentStepIds.has(stepId)) })}>Usuń odwołania do usuniętych kroków</button>}
    </details>
    {issue && <p className="admin-inline-error" role="status">{issue}</p>}
    <button type="button" className="admin-text-link admin-ai-inline-button" disabled={!suggestion} onClick={() => { if (suggestion) onChange(suggestion); }}><Sparkles size={14} />Użyj automatycznej propozycji</button>
    {!suggestion && issue && <p className="admin-subtle">Przepis nie określa jednoznacznie prezentacji. Uzupełnij naczynie, opis i kroki powyżej.</p>}
  </fieldset>;
}
