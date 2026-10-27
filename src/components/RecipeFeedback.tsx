'use client';
import { useRef, useState } from 'react';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import { recordUsage } from './UsageMetrics';

export function RecipeFeedback({ recipe, locale, completed }: { recipe: PublicRecipe; locale: Locale; sessionId?: string; completed?: boolean }) {
  const pl = locale === 'pl';
  const [kind, setKind] = useState<'success' | 'changed' | 'problem'>('success');
  const [message, setMessage] = useState(''); const [stepId, setStepId] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle'); const [error, setError] = useState('');
  const requestKey = useRef<string | null>(null);
  if (!recipe.version || !/^\d+$/.test(recipe.version)) return null;
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (state === 'sending' || state === 'sent') return;
    setState('sending'); setError(''); requestKey.current ??= crypto.randomUUID();
    try {
      const result = await fetch('/api/feedback', { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestKey: requestKey.current, recipeId: recipe.id, version: recipe.version, kind, message, ...(kind === 'problem' && stepId ? { stepId } : {}) }) });
      if (!result.ok) { const body = await result.json().catch(() => null); throw new Error(typeof body?.error === 'string' ? body.error : pl ? 'Nie udało się wysłać opinii. Zachowaj treść i spróbuj ponownie.' : 'Could not send feedback. Keep your message and try again.'); }
      setState('sent'); recordUsage('feedback_submit');
    } catch (failure) { setError(failure instanceof Error ? failure.message : pl ? 'Spróbuj ponownie.' : 'Please try again.'); setState('idle'); }
  }
  return <section className="recipe-feedback no-print" aria-labelledby="feedback-title"><h2 id="feedback-title">{completed ? pl ? 'Jak wyszło?' : 'How did it turn out?' : pl ? 'Pomóż nam poprawić przepis' : 'Help us improve this recipe'}</h2>{state === 'sent' ? <p role="status">{pl ? 'Dziękujemy! Twoja opinia trafiła do redakcji.' : 'Thank you! Your feedback has reached our editor.'}</p> : <form onSubmit={send}><fieldset disabled={state === 'sending'}><legend>{pl ? 'Twoje doświadczenie' : 'Your experience'}</legend><div className="feedback-choices">{(['success', 'changed', 'problem'] as const).map(value => <label key={value}><input type="radio" name="recipe-feedback-kind" checked={kind === value} onChange={() => { setKind(value); requestKey.current = null; }} />{({ success: pl ? 'Wyszło' : 'It worked', changed: pl ? 'Zmieniłem coś' : 'I changed something', problem: pl ? 'Mam problem' : 'I had a problem' })[value]}</label>)}</div>{kind === 'problem' && <label>{pl ? 'Który krok?' : 'Which step?'}<select value={stepId} onChange={event => { setStepId(event.target.value); requestKey.current = null; }}><option value="">{pl ? 'Cały przepis' : 'The whole recipe'}</option>{recipe.steps.map((step, index) => <option key={step.id} value={step.id}>{index + 1}. {step.title[locale]}</option>)}</select></label>}<label>{pl ? 'Wiadomość do redakcji' : 'Message to the editor'}<textarea rows={3} maxLength={1500} minLength={kind === 'success' ? 0 : 3} required={kind !== 'success'} value={message} onChange={event => { setMessage(event.target.value); requestKey.current = null; }} /></label><p>{pl ? 'Wysyłasz tylko tę opinię. Twoje prywatne notatki pozostają na urządzeniu. Nie wpisuj danych kontaktowych.' : 'Only this feedback is sent. Your private cooking notes stay on this device. Please omit contact details.'}</p>{error && <p role="alert">{error}</p>}<button type="submit" className="primary-button">{state === 'sending' ? pl ? 'Wysyłam…' : 'Sending…' : pl ? 'Wyślij do redakcji' : 'Send to editor'}</button></fieldset></form>}</section>;
}
