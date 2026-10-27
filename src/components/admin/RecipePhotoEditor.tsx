'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ImagePlus, LoaderCircle } from 'lucide-react';
import { MediaImage } from '@/components/MediaImage';
import { RecipePhoto } from '@/components/RecipePhoto';
import type { CreateAiJob } from '@/lib/ai-types';
import type { EditorialRecord } from '@/lib/editorial-types';

export type PhotoEditorLock = { busy: boolean; dirty: boolean; pending: boolean };
type Props = {
  record: EditorialRecord;
  contentApproved: boolean;
  disabled: boolean;
  onReload: () => Promise<EditorialRecord>;
  onLockChange: (lock: PhotoEditorLock) => void;
};
type PhotoRequest = CreateAiJob & { kind: 'hero' | 'ingredient' | 'step'; regenerate: true };
const message = (error: unknown) => error instanceof TypeError ? 'Brak połączenia z serwisem. Sprawdź aktualny stan przed kolejną operacją.' : error instanceof Error ? error.message.replace(/OpenAI(?: API)?/g, 'generator treści').replace(/fal\.ai/g, 'generator zdjęć') : 'Nie udało się połączyć z serwisem.';

function readPending(value: string | null, recipeId: string): PhotoRequest | null {
  try {
    const request = JSON.parse(value ?? 'null') as Partial<PhotoRequest> | null;
    if (!request || request.recipeId !== recipeId || !['hero', 'ingredient', 'step'].includes(request.kind ?? '') || request.regenerate !== true
      || !Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 1 || typeof request.requestKey !== 'string'
      || !/^[a-f0-9-]{36}$/i.test(request.requestKey) || typeof request.brief !== 'string' || !request.brief.trim() || request.brief.length > 2000
      || (request.kind !== 'hero' && typeof request.targetId !== 'string')) return null;
    return { recipeId, expectedRevision: request.expectedRevision!, kind: request.kind!, brief: request.brief, requestKey: request.requestKey,
      regenerate: true, ...(request.kind !== 'hero' ? { targetId: request.targetId } : {}) };
  } catch { return null; }
}

export function RecipePhotoEditor({ record, contentApproved, disabled, onReload, onLockChange }: Props) {
  const id = useId();
  const router = useRouter();
  const [target, setTarget] = useState('hero');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState<'generate' | 'reload' | null>(null);
  const [pending, setPending] = useState<PhotoRequest | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const busyRef = useRef(false);
  const pendingRef = useRef<PhotoRequest | null>(null);
  const storageKey = `jesie:recipe-photo-request:v1:${record.id}`;
  const recipe = record.content.recipe;
  const [kind, targetId] = target.split(':') as ['hero' | 'ingredient' | 'step', string | undefined];
  const ingredient = kind === 'ingredient' ? recipe.ingredients.find(item => item.id === targetId) : undefined;
  const step = kind === 'step' ? recipe.steps.find(item => item.id === targetId) : undefined;
  const targetExists = kind === 'hero' || Boolean(ingredient || step);
  const photo = kind === 'ingredient' && targetId ? record.content.photos.ingredients[targetId] : kind === 'step' && targetId ? record.content.photos.steps[targetId] : null;
  const frozen = disabled || Boolean(busy) || Boolean(pending) || conflict;

  const keepPending = (request: PhotoRequest | null) => {
    pendingRef.current = request;
    setPending(request);
    try { if (request) sessionStorage.setItem(storageKey, JSON.stringify(request)); else sessionStorage.removeItem(storageKey); } catch { /* The same request remains available in this tab. */ }
  };

  useEffect(() => {
    let request: PhotoRequest | null = null;
    try { request = readPending(sessionStorage.getItem(storageKey), record.id); } catch { /* Browser storage may be disabled. */ }
    pendingRef.current = request;
    queueMicrotask(() => {
      setPending(request);
      if (request) { setTarget(request.kind === 'hero' ? 'hero' : `${request.kind}:${request.targetId}`); setBrief(request.brief); }
    });
  }, [record.id, storageKey]);

  useEffect(() => { onLockChange({ busy: Boolean(busy), dirty: false, pending: Boolean(pending) }); }, [busy, onLockChange, pending]);

  const reload = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('reload'); setError('');
    try {
      await onReload(); setConflict(false);
      setNotice('Stan przepisu jest aktualny.');
    } catch (failure) { setError(message(failure)); }
    finally { busyRef.current = false; setBusy(null); }
  };

  const generate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current || (!pendingRef.current && (frozen || !contentApproved || !brief.trim() || !targetExists))) return;
    busyRef.current = true; setBusy('generate'); setError(''); setNotice('');
    if (!pendingRef.current) keepPending({ recipeId: record.id, expectedRevision: record.revision, kind,
      ...(kind !== 'hero' ? { targetId } : {}), brief: brief.trim(), requestKey: crypto.randomUUID(), regenerate: true });
    try {
      const response = await fetch('/api/admin/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingRef.current) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 || body.code === 'PROVIDER_NOT_CONFIGURED') keepPending(null);
        if (response.status === 409) setConflict(true);
        throw new Error(response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : body.error || 'Nie udało się potwierdzić zlecenia. Sprawdź to samo zgłoszenie ponownie.');
      }
      if (!body.job?.id) throw new Error('Nie otrzymaliśmy potwierdzenia zlecenia. Sprawdź to samo zgłoszenie ponownie.');
      keepPending(null);
      router.push(`/admin/ai/${encodeURIComponent(body.job.id)}`);
    } catch (failure) { setError(message(failure)); }
    finally { busyRef.current = false; setBusy(null); }
  };

  return <div className="guided-photo-editor">
    <form onSubmit={event => void generate(event)} aria-labelledby={id + '-heading'}>
      <h3 id={id + '-heading'}>Zmień lub wygeneruj dowolne zdjęcie</h3>
      <p className="guided-photo-help">Wybierz zdjęcie i opisz własnymi słowami, jak ma wyglądać. Gotową propozycję obejrzysz i osobno zastosujesz do szkicu.</p>
      <fieldset disabled={frozen} className="guided-photo-fields">
        <label className="admin-field" htmlFor={id + '-target'}>Które zdjęcie?
          <select id={id + '-target'} value={target} onChange={event => { setTarget(event.target.value); setNotice(''); }}>
            <option value="hero">Gotowa potrawa</option>
            <optgroup label="Składniki">{recipe.ingredients.map(item => <option key={item.id} value={`ingredient:${item.id}`}>{item.name.pl || item.name.en}</option>)}</optgroup>
            <optgroup label="Kroki przygotowania">{recipe.steps.map((item, index) => <option key={item.id} value={`step:${item.id}`}>{index + 1}. {item.title.pl || item.title.en}</option>)}</optgroup>
          </select>
        </label>
        {(kind === 'hero' && recipe.image || photo) && <figure className={`guided-photo-current ${kind === 'hero' ? 'is-hero' : ''}`}>
          {kind === 'hero' ? <MediaImage src={recipe.image} alt={recipe.imageAlt.pl || recipe.title.pl} width={220} height={165} maximumWidth={320} sizes="220px" /> : photo ? <RecipePhoto media={photo} locale="pl" sizes="220px" maximumWidth={320} /> : null}
          <figcaption>Obecne zdjęcie</figcaption>
        </figure>}
        <label className="admin-field" htmlFor={id + '-brief'}>Jak ma wyglądać zdjęcie?
          <textarea id={id + '-brief'} rows={4} required maxLength={2000} value={brief} onChange={event => setBrief(event.target.value)} aria-describedby={id + '-help'} placeholder={kind === 'hero' ? 'Np. Pokaż kurczaka z ryżem w glinianym garnku, z błyszczącym marynowanym żółtkiem na wierzchu, tak jak w ostatnim kroku przepisu.' : kind === 'ingredient' ? 'Np. Pokaż cały korzeń imbiru z jednym świeżo odkrojonym plasterkiem.' : 'Np. Zbliżenie na patelnię: cebula powinna być szklista, ale jeszcze nie zrumieniona.'} />
          <small id={id + '-help'}>{kind === 'hero' ? 'Uwzględnimy przepis i Twój opis podania, naczynia oraz rekwizytów. Zachowamy całą kompozycję; gotowe zdjęcie obejrzysz przed zastosowaniem.' : 'Uwzględnimy cały przepis i Twoje wskazówki. Powstanie nowe zdjęcie wybranego miejsca.'}</small>
        </label>
      </fieldset>
      {!contentApproved && <p className="guided-photo-help">Najpierw zaakceptuj treść przepisu w etapie 1.</p>}
      {pending && <p className="guided-photo-help" role="status">Zachowaliśmy zgłoszenie. Kolejne sprawdzenie użyje tego samego identyfikatora.</p>}
      <div className="guided-photo-actions"><button type="submit" className="admin-button" disabled={Boolean(busy) || !pending && (disabled || conflict || !contentApproved || !brief.trim() || !targetExists)}>{busy === 'generate' ? <LoaderCircle size={17} className="admin-spinner" /> : <ImagePlus size={17} />}{pending ? 'Sprawdź to samo zgłoszenie' : 'Wygeneruj propozycję zdjęcia'}</button></div>
    </form>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><div><p>{error}</p>{conflict && <button type="button" className="admin-text-link" disabled={Boolean(busy)} onClick={() => void reload()}>Wczytaj aktualny przepis</button>}</div></div>}
    {notice && <p className="guided-photo-help" role="status">{notice}</p>}
  </div>;
}
