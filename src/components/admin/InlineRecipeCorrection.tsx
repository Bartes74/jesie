'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorialRecord } from '@/lib/editorial-types';
import type { IngredientUnit, Locale } from '@/lib/recipes';
import { applyRecipeCorrection, readStoredRecipeCorrection, type RecipeCorrection } from '@/lib/recipe-correction';
import { getStepTimerMinutes, maxStepTimerMinutes, stepTimerIssue } from '@/lib/step-timer-policy';
import { formatRecipeDuration } from '@/lib/recipe-duration';

type Props = { record: EditorialRecord; initial: RecipeCorrection; locale: Locale; onSaved: (record: EditorialRecord) => void; onClose: () => void };
export function InlineRecipeCorrection({ record, initial, locale, onSaved, onClose }: Props) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error' | 'conflict'>('saved');
  const [error, setError] = useState('');
  const [timerError, setTimerError] = useState('');
  const [recovery, setRecovery] = useState<{ revision: number; correction: RecipeCorrection } | null>(null);
  const recordRef = useRef(record); const draftRef = useRef(draft);
  const persisted = useRef(JSON.stringify(initial)); const pending = useRef<Promise<boolean> | null>(null);
  const conflicted = useRef(false);
  const section = useRef<HTMLElement>(null);
  const key = `jesie:inline-correction:${record.id}:${initial.kind}:${initial.item.id}`;
  useEffect(() => {
    try {
      const value = readStoredRecipeCorrection(localStorage.getItem(key), { kind: initial.kind, id: initial.item.id });
      if (value && JSON.stringify(value.correction) !== persisted.current) queueMicrotask(() => setRecovery(value));
    } catch {}
  }, [initial.kind, initial.item.id, key]);
  useEffect(() => {
    section.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    section.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')?.focus({ preventScroll: true });
  }, []);
  const edit = (change: (next: RecipeCorrection) => void) => {
    const next = structuredClone(draftRef.current); change(next); draftRef.current = next; setDraft(next); setStatus('dirty');
    try { localStorage.setItem(key, JSON.stringify({ revision: recordRef.current.revision, correction: next })); } catch {}
  };
  const save = useCallback(async (): Promise<boolean> => {
    while (pending.current) await pending.current;
    if (conflicted.current) return false;
    const correction = draftRef.current; const serialized = JSON.stringify(correction);
    if (serialized === persisted.current) return true;
    const operation = (async () => {
      setStatus('saving'); setError('');
      try {
        const content = applyRecipeCorrection(recordRef.current.content, correction);
        const response = await fetch(`/api/admin/recipes/${encodeURIComponent(record.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: recordRef.current.revision, content }) });
        const body = await response.json();
        if (response.status === 409) { conflicted.current = true; setStatus('conflict'); throw new Error('Przepis zmienił się w innym miejscu. Zachowaliśmy korektę w przeglądarce. Otwórz aktualną wersję i porównaj zmiany.'); }
        if (!response.ok || !body.recipe) throw new Error(body.error || 'Nie udało się zapisać korekty.');
        recordRef.current = body.recipe; persisted.current = serialized; onSaved(body.recipe);
        const clean = JSON.stringify(draftRef.current) === serialized;
        setStatus(clean ? 'saved' : 'dirty');
        try { if (clean) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify({ revision: body.recipe.revision, correction: draftRef.current })); } catch {}
        return true;
      } catch (failure) { if (!conflicted.current) setStatus('error'); setError(failure instanceof Error ? failure.message : 'Brak połączenia. Korekta pozostaje w przeglądarce.'); return false; }
    })();
    pending.current = operation; const result = await operation; pending.current = null; return result;
  }, [key, onSaved, record.id]);
  const flush = useCallback(async () => {
    for (let attempt = 0; attempt < 10; attempt++) { if (!await save()) return false; if (JSON.stringify(draftRef.current) === persisted.current) return true; }
    return false;
  }, [save]);
  useEffect(() => {
    if (status !== 'dirty') return;
    const timer = setTimeout(() => void save(), 950);
    return () => clearTimeout(timer);
  }, [draft, save, status]);
  useEffect(() => {
    const beforeLeave = (event: BeforeUnloadEvent) => { if (JSON.stringify(draftRef.current) !== persisted.current) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || JSON.stringify(draftRef.current) === persisted.current) return;
      event.preventDefault(); event.stopPropagation();
      void flush().then(saved => { if (saved) window.location.assign(anchor.href); });
    };
    window.addEventListener('beforeunload', beforeLeave); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', beforeLeave); document.removeEventListener('click', navigate, true); };
  }, [flush]);
  const download = (correction = draftRef.current) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(correction, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'korekta-przepisu.json'; anchor.click(); URL.revokeObjectURL(url);
  };
  const ingredient = draft.kind === 'ingredient' ? draft.item : null;
  const step = draft.kind === 'step' ? draft.item : null;
  const changeTimer = (input: HTMLInputElement) => {
    const current = draftRef.current;
    if (current.kind !== 'step') return;
    const minutes = Number(input.value), candidate = { ...current.item, timerMinutes: minutes };
    if (input.validity.badInput || input.value !== '' && (!Number.isSafeInteger(minutes) || minutes < 1 || getStepTimerMinutes(candidate) !== minutes)) {
      setTimerError(`Nie zmieniono minutnika. ${stepTimerIssue(candidate) ?? 'Wpisz dodatnią liczbę całkowitą minut.'}`);
      return;
    }
    setTimerError('');
    edit(next => { if (next.kind === 'step') { if (input.value === '') delete next.item.timerMinutes; else next.item.timerMinutes = minutes; } });
  };
  return <section ref={section} className="admin-section guided-inline-correction" aria-label="Ręczna korekta przepisu">
    <h3>{ingredient ? 'Popraw składnik' : 'Popraw krok'} · {locale.toUpperCase()}</h3>
    <p>Zmiany zapisują się automatycznie. Sprawdź zgodność obu języków i istniejącego zdjęcia po korekcie.</p>
    {recovery && <div className="admin-notice"><div><p>W przeglądarce jest niezapisana korekta wersji {recovery.revision}.</p><details><summary>Porównaj zachowaną korektę</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(recovery.correction.item, null, 2)}</pre></details><div className="admin-actions">{recovery.revision === record.revision && <button type="button" className="admin-button is-secondary" onClick={() => { const next = recovery.correction; draftRef.current = next; setDraft(next); setStatus('dirty'); setRecovery(null); }}>Przywróć korektę</button>}<button type="button" className="admin-button is-secondary" onClick={() => download(recovery.correction)}>Pobierz zachowaną korektę</button><button type="button" className="admin-text-link" onClick={() => { setRecovery(null); try { localStorage.removeItem(key); } catch {} }}>Odrzuć kopię lokalną</button></div>{recovery.revision !== record.revision && <p>Aktualna wersja jest nowsza. Porównaj pola i wprowadź potrzebne zmiany poniżej.</p>}</div></div>}
    <fieldset disabled={status === 'conflict'} style={{ border: 0, padding: 0, minWidth: 0 }}>
      {ingredient && <>
        <label className="admin-field">Nazwa<input value={ingredient.name[locale]} onChange={event => edit(next => { if (next.kind === 'ingredient') next.item.name[locale] = event.target.value; })} /></label>
        <div className="admin-field-grid">
          {ingredient.amount.kind === 'exact' && <label className="admin-field">Ilość<input inputMode="decimal" value={ingredient.amount.value} onChange={event => edit(next => { if (next.kind === 'ingredient' && next.item.amount.kind === 'exact') next.item.amount.value = event.target.value.replace(',', '.'); })} /></label>}
          {ingredient.amount.kind === 'range' && <><label className="admin-field">Od<input inputMode="decimal" value={ingredient.amount.min} onChange={event => edit(next => { if (next.kind === 'ingredient' && next.item.amount.kind === 'range') next.item.amount.min = event.target.value.replace(',', '.'); })} /></label><label className="admin-field">Do<input inputMode="decimal" value={ingredient.amount.max} onChange={event => edit(next => { if (next.kind === 'ingredient' && next.item.amount.kind === 'range') next.item.amount.max = event.target.value.replace(',', '.'); })} /></label></>}
          {ingredient.amount.kind === 'qualitative' && <label className="admin-field">Ilość opisowo<input value={ingredient.amount.text[locale]} onChange={event => edit(next => { if (next.kind === 'ingredient' && next.item.amount.kind === 'qualitative') next.item.amount.text[locale] = event.target.value; })} /></label>}
          {ingredient.amount.kind !== 'qualitative' && <label className="admin-field">Jednostka<select value={ingredient.unit ?? ''} onChange={event => edit(next => { if (next.kind === 'ingredient') next.item.unit = (event.target.value || null) as IngredientUnit; })}>{[['g', 'g'], ['ml', 'ml'], ['count', 'szt.'], ['tsp', 'łyżeczka'], ['tbsp', 'łyżka'], ['', 'bez jednostki']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        </div>
        <label className="admin-field">Wskazówka<input value={ingredient.note?.[locale] ?? ''} onChange={event => edit(next => { if (next.kind === 'ingredient') { next.item.note ??= { pl: '', en: '' }; next.item.note[locale] = event.target.value; } })} /></label>
      </>}
      {step && <>
        <label className="admin-field">Tytuł<input value={step.title[locale]} onChange={event => edit(next => { if (next.kind === 'step') next.item.title[locale] = event.target.value; })} /></label>
        <label className="admin-field">Opis<textarea rows={6} value={step.text[locale]} onChange={event => edit(next => { if (next.kind === 'step') next.item.text[locale] = event.target.value; })} /><small>Zachowaj odwołania do składników w nawiasach, np. {'{{ingredient-id}}'}.</small></label>
        <div>
          <label className="admin-field">Minutnik · min<input type="number" min="1" max={maxStepTimerMinutes} step="1" value={step.timerMinutes ?? ''} aria-describedby="inline-step-timer-help" onChange={event => changeTimer(event.currentTarget)} /><small id="inline-step-timer-help">Opcjonalnie, do {formatRecipeDuration(maxStepTimerMinutes, 'pl')}. Oczekiwanie przez noc lub cały dzień zapisz w opisie i czasie przepisu. Puste pole usuwa minutnik.</small></label>
          {timerError && <p className="admin-inline-error" role="alert">{timerError}</p>}
          {step.timerMinutes !== undefined && getStepTimerMinutes(step) === null && <p className="admin-inline-error">{stepTimerIssue(step)} Ten zapisany minutnik nie pojawi się w przepisie. Możesz usunąć go poniżej; opis i pełny czas pozostaną.</p>}
          {step.timerMinutes !== undefined && <button type="button" className="admin-button is-subtle" onClick={() => { setTimerError(''); edit(next => { if (next.kind === 'step') delete next.item.timerMinutes; }); }}>Usuń minutnik</button>}
        </div>
      </>}
    </fieldset>
    <p role="status">{status === 'saved' ? 'Wszystkie zmiany zapisane.' : status === 'saving' ? 'Zapisuję korektę…' : status === 'dirty' ? 'Zmiany czekają na zapis…' : 'Korekta wymaga uwagi.'}</p>
    {error && <p role="alert">{error}</p>}
    <div className="admin-actions"><button type="button" className="admin-button" disabled={status === 'saving' || status === 'conflict'} onClick={() => void flush().then(saved => { if (saved) onClose(); })}>Zapisz i wróć</button>{(status === 'conflict' || status === 'error') && <button type="button" className="admin-button is-secondary" onClick={() => download()}>Pobierz moją korektę</button>}{status === 'conflict' && <button type="button" className="admin-button is-secondary" onClick={onClose}>Zamknij i wczytaj aktualny przepis</button>}</div>
  </section>;
}
