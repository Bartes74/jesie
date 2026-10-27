import Link from 'next/link';
import { AlertCircle, ArrowRight, CheckCircle2, LoaderCircle } from 'lucide-react';
import type { AiJob } from '@/lib/ai-types';
import { aiJobFeedback, recipeRecoveryProgressMessage } from '@/lib/ai-job-feedback';
import './job-recovery.css';

export function JobRecoveryNotice({ job, currentRevision, disabled = false, busy = false, onRecover, onRecheck, onResume, onEdit, onRefresh, editHref }: { job: AiJob; currentRevision?: number; disabled?: boolean; busy?: boolean; onRecover?: () => void; onRecheck?: () => void; onResume?: () => void; onEdit?: () => void; onRefresh?: () => void; editHref?: string }) {
  const feedback = aiJobFeedback(job, currentRevision);
  if (!feedback) return null;
  const primary = feedback.primary;
  const handler = primary?.action === 'recover' ? onRecover : primary?.action === 'recheck' ? onRecheck : primary?.action === 'resume' ? onResume : primary?.action === 'edit' ? onEdit : primary?.action === 'refresh' ? onRefresh : undefined;
  return <section className={`job-recovery is-${feedback.tone}`} role="status" aria-live="polite" aria-atomic="true">
    {feedback.tone === 'working' || busy ? <LoaderCircle size={22} className="admin-spinner" /> : feedback.tone === 'success' ? <CheckCircle2 size={22} /> : <AlertCircle size={22} />}
    <div className="job-recovery-body"><h3>{feedback.title}</h3><p>{feedback.description}</p>
      {feedback.progress && <p className="job-recovery-attempt">{recipeRecoveryProgressMessage(feedback)}</p>}
      {feedback.reason && <p><strong>Przyczyna: </strong>{feedback.reason}</p>}
      {feedback.issues.length > 0 && <div className="job-recovery-issues"><strong>{feedback.tone === 'working' ? 'Sprawdzane pola:' : 'Do uzupełnienia:'}</strong><ul>{feedback.issues.map((issue, index) => <li key={`${issue.field}:${index}`}><strong>{issue.label}:</strong> {issue.message}</li>)}</ul></div>}
      {primary && (handler ? <button type="button" className="admin-button is-secondary" disabled={disabled || busy} onClick={handler}>{busy ? <LoaderCircle size={16} className="admin-spinner" /> : <ArrowRight size={16} />}{busy ? 'Sprawdzam zgłoszenie…' : primary.label}</button> : primary.href ? <Link className="admin-button is-secondary" href={primary.action === 'edit' && editHref ? editHref : primary.href}>{primary.label}<ArrowRight size={16} /></Link> : null)}
      {job.recovery?.status === 'exhausted' && (primary?.action === 'recover' || primary?.action === 'recheck') && <div>{onEdit
        ? <button type="button" className="admin-text-link" disabled={disabled || busy} onClick={onEdit}>Popraw wskazówki<ArrowRight size={15} /></button>
        : <Link className="admin-text-link" href={editHref ?? `/admin/recipes/${encodeURIComponent(job.recipeId)}`}>Popraw wskazówki<ArrowRight size={15} /></Link>}</div>}
      {primary?.action === 'settings' && job.recovery?.canResume && (job.kind === 'recipe' && job.providerRequestId ? onRecheck : onRecover) && <div><button type="button" className="admin-text-link" disabled={disabled || busy} onClick={job.kind === 'recipe' && job.providerRequestId ? onRecheck : onRecover}>{job.kind === 'recipe' && job.providerRequestId ? 'Po zmianie ustawień sprawdź zapisany wynik' : 'Po zmianie ustawień dokończ przepis'}<ArrowRight size={15} /></button></div>}
      {(job.errorCode || job.errorMessage) && <details className="job-recovery-diagnostics"><summary>Szczegóły diagnostyczne</summary>{job.errorMessage && <p>{job.errorMessage}</p>}{job.errorCode && <p>Kod: {job.errorCode.replace(/^AI_/, '')}</p>}</details>}
    </div>
  </section>;
}
