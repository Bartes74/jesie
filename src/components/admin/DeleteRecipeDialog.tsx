'use client';

import { useEffect, useId, useRef } from 'react';
import { AlertCircle, Download, LoaderCircle, Trash2 } from 'lucide-react';

type DeleteRecipeDialogProps = {
  title: string;
  published: boolean;
  unsaved?: boolean;
  busy: boolean;
  error?: string;
  conflict?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onDownloadDraft?: () => void;
};

export function DeleteRecipeDialog({ title, published, unsaved = false, busy, error, conflict = false, onConfirm, onClose, onDownloadDraft }: DeleteRecipeDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog ref={dialog} className="admin-modal admin-delete-dialog" aria-labelledby={headingId} aria-describedby={descriptionId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={headingId}>Usunąć przepis?</h2>
    <div id={descriptionId} className="admin-delete-description">
      <p><strong>{title || 'Bez tytułu'}</strong> trafi do kosza. Możesz go później przywrócić jako szkic.</p>
      {published && <p>Przepis zostanie wycofany z serwisu. Jego publiczne adresy przestaną być dostępne.</p>}
      <p>Zdjęcia i historia wersji pozostaną zachowane.</p>
      {unsaved && <p className="admin-delete-unsaved">Masz niezapisane zmiany. Do kosza trafi ostatnia zapisana wersja. Pobierz swój szkic, jeśli chcesz zachować te zmiany. Dostępna kopia lokalna pozostanie w tej przeglądarce.</p>}
    </div>
    {error && <div className="admin-notice is-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    {busy && <p className="admin-delete-progress" role="status"><LoaderCircle size={17} className="admin-spinner" />Przenoszę przepis do kosza…</p>}
    <div className="admin-actions">
      <button ref={cancel} type="button" className="admin-button is-secondary" disabled={busy} onClick={onClose}>Anuluj</button>
      {unsaved && onDownloadDraft && <button type="button" className="admin-button is-subtle" disabled={busy} onClick={onDownloadDraft}><Download size={17} />Pobierz mój szkic</button>}
      <button type="button" className="admin-button is-danger" disabled={busy || conflict} onClick={onConfirm}><Trash2 size={17} />Usuń przepis</button>
    </div>
  </dialog>;
}
