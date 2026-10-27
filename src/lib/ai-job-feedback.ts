import type { AiJob } from './ai-types';

export type AiJobFeedback = {
  tone: 'working' | 'success' | 'warning';
  title: string;
  description: string;
  reason?: string;
  progress?: { attempt: number; maxAttempts: number };
  issues: { field: string; label: string; message: string }[];
  primary?: { action: 'recover' | 'resume' | 'edit' | 'settings' | 'view' | 'refresh'; label: string; href?: string };
};

export function jobHasOngoingWork(job: AiJob | null | undefined): boolean {
  if (job?.photoSourceStatus) return false;
  return Boolean(job && (['queued', 'submitting', 'generating'].includes(job.status) || job.recovery?.status === 'recovering'
    || !job.manualPhotoComposition && job.photoRecovery && ['queued', 'submitting', 'generating'].includes(job.photoRecovery.status)));
}

/** Read-only grace covers the gap between a finished photo and its separate mask admission. */
export function photoRecoveryPollInterval(job: AiJob | null | undefined, now = Date.now()): number | null {
  if (!job || job.kind !== 'hero' || job.manualPhotoComposition || job.photoSourceStatus) return null;
  if (job.photoRecovery) return ['queued', 'submitting', 'generating'].includes(job.photoRecovery.status) ? 4000 : null;
  if (job.status !== 'failed' || job.errorCode !== 'AI_TRANSPARENCY_MISSING' || !job.providerRequestId || job.result) return null;
  const age = now - Date.parse(job.updatedAt);
  return age >= 0 && age < 120_000 ? 4000 : null;
}

function photoJobFeedback(job: AiJob): AiJobFeedback | null {
  const recovery = job.photoRecovery;
  const base = { issues: [] };
  if (job.kind === 'hero' && job.model === 'fal-ai/sam-3/image' && job.photoSourceJobId && job.photoSourceStatus) return {
    ...base, tone: 'success', title: job.photoSourceStatus === 'applied' ? 'Zdjęcie źródłowe jest zapisane w szkicu' : 'Fotografia źródłowa jest gotowa',
    description: 'Zachowana fotografia została odzyskana. To wcześniejsze zadanie wycięcia tła pozostaje w historii; gotowy kadr znajdziesz przy źródłowym zdjęciu.',
    primary: { action: 'view', label: 'Zobacz gotowe zdjęcie', href: `/admin/ai/${encodeURIComponent(job.photoSourceJobId)}` },
  };
  if (job.manualPhotoComposition && job.kind === 'hero' && job.status === 'failed' && job.errorCode === 'AI_TRANSPARENCY_MISSING') return {
    ...base, tone: 'warning', title: 'Gotowa fotografia jest zachowana',
    description: 'Obejrzyj oryginał poniżej i porównaj go ze swoimi wskazówkami. To wcześniejsze zgłoszenie zatrzymało się na przygotowaniu formatu; fotografia nie została jeszcze zapisana jako gotowy wynik.',
  };
  if (recovery) {
    const primary = { action: 'view' as const, label: ['ready', 'applied'].includes(recovery.status) ? 'Zobacz gotowe zdjęcie' : 'Sprawdź wycięcie tła', href: `/admin/ai/${encodeURIComponent(recovery.jobId)}` };
    if (['ready', 'applied'].includes(recovery.status)) return { ...base, tone: 'success', title: 'Zdjęcie po wycięciu tła jest gotowe', description: 'Otwórz gotowy kadr, sprawdź potrawę i naczynie, a następnie osobno zastosuj zdjęcie do szkicu.', primary };
    if (['queued', 'submitting', 'generating'].includes(recovery.status)) return { ...base, tone: 'working', title: 'Przygotowujemy tło gotowego zdjęcia', description: 'Fotografia już powstała. Osobna korekta wycina tło z istniejącego zdjęcia. Gotowy kadr otrzymasz do sprawdzenia.', primary };
    return { ...base, tone: 'warning', title: 'Wycięcie tła wymaga sprawdzenia', description: 'Fotografia powstała, ale osobne zlecenie wycięcia tła wymaga uwagi. Sprawdź jego stan i dostępne działania.', primary };
  }
  if (job.kind === 'hero' && job.status === 'failed' && job.errorCode === 'AI_TRANSPARENCY_MISSING') return { ...base, tone: 'warning', title: 'Zdjęcie powstało, wymaga wycięcia tła', description: 'Gotowa fotografia wymaga przygotowania przezroczystego tła. Korekta wykorzystuje istniejące zdjęcie; jej wynik sprawdzisz przed zastosowaniem do szkicu.' };
  if (job.canRestorePhotoContents && job.status === 'failed') return { ...base, tone: 'warning', title: 'Przywróć potrawę wewnątrz naczynia', description: 'Wycięcie usunęło środek potrawy lub naczynia. Przywrócimy go z zachowanego oryginału, korzystając z istniejącego wyniku. Ta korekta nie zleca nowej fotografii ani kolejnej płatnej maski.', primary: { action: 'resume', label: 'Przywróć potrawę z oryginału' } };
  if (job.model === 'fal-ai/sam-3/image' && ['queued', 'submitting', 'generating'].includes(job.status)) return { ...base, tone: 'working', title: 'Przygotowujemy tło gotowego zdjęcia', description: 'Wycinamy tło z istniejącej fotografii, zachowując potrawę i naczynie. Gotowy kadr sprawdzisz i osobno zastosujesz do szkicu.' };
  if (job.model === 'fal-ai/sam-3/image' && job.status === 'failed' && ['AI_MASK_NOT_FOUND', 'AI_IMAGE_INVALID', 'PHOTO_MASK_INVALID', 'PHOTO_CUTOUT_INVALID', 'AI_IMAGE_FORMAT_FAILED'].includes(job.errorCode ?? '')) return { ...base, tone: 'warning', title: 'Wycięcie tła wymaga sprawdzenia', description: 'Nie udało się zakończyć przygotowania wycięcia. Sprawdź komunikat i dostępne działania dla tej korekty.' };
  if (job.status === 'failed' && job.errorCode === 'AI_IMAGE_FORMAT_FAILED') return { ...base, tone: 'warning', title: 'Formatowanie zdjęcia wymaga sprawdzenia', description: 'Nie udało się zapisać wymaganej postaci zdjęcia. Sprawdź komunikat i dostępne działania dla tej korekty.' };
  return null;
}

/** A changed brief starts a new lineage; an unchanged invalid result uses bounded recovery. */
export function canStartNewRecipeText(job: AiJob | null, revision: number): boolean {
  return !job || job.status === 'cancelled' || job.status === 'failed' && (job.baseRevision !== revision || !job.recovery && !/RESULT_INVALID|RESEARCH_SOURCE_INVALID/.test(job.errorCode ?? ''));
}

export function recipeIssueLabel(field: string): string {
  if (/source|bibliograph|research/i.test(field)) return 'Źródła i research';
  if (/substitution/i.test(field)) return 'Zamienniki';
  if (/ingredient|quantity|amount|unit/i.test(field)) return 'Składniki i ilości';
  if (/step|method|instruction/i.test(field)) return 'Kroki przygotowania';
  if (/description/i.test(field)) return 'Opis przepisu';
  if (/title|slug/i.test(field)) return 'Tytuł przepisu';
  if (/time|minute/i.test(field)) return 'Czas przygotowania';
  if (/serving|scaling/i.test(field)) return 'Porcje i przeliczanie';
  if (/equipment/i.test(field)) return 'Sprzęt';
  if (/storage/i.test(field)) return 'Przechowywanie';
  if (/tip/i.test(field)) return 'Wskazówki';
  if (/provenance/i.test(field)) return 'Informacje o przepisie';
  return 'Treść przepisu';
}

function issueMessage(message: string): string {
  if (/^Invalid input: expected|^Required|^Invalid type/i.test(message)) return 'Brakuje wymaganej informacji lub ma ona nieprawidłowy format.';
  if (/^Too small|^Too big/i.test(message)) return 'Ta informacja wymaga uzupełnienia lub skrócenia.';
  return message.replace(/OpenAI(?: API)?/g, 'generator treści').replace(/fal\.ai/g, 'generator zdjęć');
}

export function aiJobFeedback(job: AiJob, currentRevision?: number): AiJobFeedback | null {
  if (job.kind !== 'recipe') return photoJobFeedback(job);
  const recovery = job.recovery;
  const recipeHref = `/admin/recipes/${encodeURIComponent(job.recipeId)}`;
  const edit = { action: 'edit' as const, label: job.kind === 'recipe' ? 'Popraw wskazówki' : 'Otwórz przepis', href: recipeHref };
  const issues = (recovery?.issues ?? []).map(issue => ({ ...issue, label: recipeIssueLabel(issue.field), message: issueMessage(issue.message) }));
  const progress = recovery ? { attempt: recovery.attempt, maxAttempts: recovery.maxAttempts } : undefined;
  const base = { issues, progress };
  const code = (recovery?.code || job.errorCode || '').toUpperCase();
  const stale = job.status !== 'applied' && (currentRevision !== undefined && currentRevision !== job.baseRevision || /STALE|REVISION_CONFLICT/.test(code));
  const reason = recovery?.reason && !/^[A-Z][A-Z_0-9]+$/.test(recovery.reason) ? issueMessage(recovery.reason) : undefined;

  if (job.status === 'generating' && job.errorCode === 'AI_INGREDIENT_VERIFICATION_PENDING') return {
    ...base, tone: 'working', title: 'Sprawdzamy nieznany składnik',
    description: job.errorMessage || 'Porównujemy nazwę ze źródłami kulinarnymi. Po potwierdzeniu sprawdzimy zachowany przepis ponownie.',
  };
  if (recovery?.status === 'ready' && recovery.jobId && recovery.jobId !== job.id) return { ...base, tone: 'success', title: 'Poprawiony przepis jest gotowy', description: 'Automatyczna naprawa zakończyła się. Otwórz gotowy wynik, przeczytaj go i zdecyduj, czy zapisać go w szkicu.', primary: { action: 'view', label: 'Zobacz gotowy przepis', href: `/admin/ai/${encodeURIComponent(recovery.jobId)}` } };
  if (recovery?.status === 'recovering') return { ...base, tone: 'working', title: 'Automatycznie poprawiamy przepis', description: 'Wykryliśmy brakujące lub niespójne informacje. System przekazał je do poprawy i ponownie sprawdzi całość. Możesz wrócić później; postęp odświeża się automatycznie.', reason };
  if (job.status === 'ready' || job.status === 'applied' || jobHasOngoingWork(job)) return null;
  if (/AUTH|API_KEY|CREDENTIAL|CONFIG|MODEL_ACCESS|MODEL_NOT_APPROVED|PROVIDER_REJECTED/.test(code)) return { ...base, tone: 'warning', title: 'Generator wymaga poprawnej konfiguracji', description: 'Nie możemy kontynuować bez dostępu do usługi. Sprawdź konfigurację generatora w ustawieniach, a następnie wróć do tego przepisu.', reason, primary: { action: 'settings', label: 'Otwórz ustawienia', href: '/admin/settings' } };
  if (/BUDGET|PACKET_LIMIT|QUOTA|INSUFFICIENT|CREDIT|PAYMENT|BILLING/.test(code)) return { ...base, tone: 'warning', title: 'Brak dostępnego budżetu na dalszą pracę', description: 'Gotowe materiały są zachowane. Sprawdź limit i dostępne środki w ustawieniach; kontynuacja będzie możliwa po usunięciu blokady.', reason, primary: { action: 'settings', label: 'Sprawdź budżet', href: '/admin/settings' } };
  if (job.status === 'uncertain') return { ...base, tone: 'warning', title: 'Sprawdzamy, czy generator zakończył pracę', description: job.providerRequestId || job.reuseSourceJobId ? 'Zapisane zgłoszenie może nadal być wykonywane. Sprawdź jego istniejący wynik przed kolejnym działaniem.' : 'Usługa nie potwierdziła przyjęcia zgłoszenia. Odśwież stan tego zadania; do czasu wyjaśnienia nie rozpoczynaj kolejnego generowania.', primary: job.providerRequestId || job.reuseSourceJobId ? { action: 'resume', label: 'Sprawdź istniejące zgłoszenie' } : { action: 'refresh', label: 'Odśwież stan zgłoszenia' } };
  if (stale) return { ...base, tone: 'warning', title: 'Przepis zmienił się od rozpoczęcia pracy', description: 'Zachowaliśmy Twoje zmiany. Sprawdź aktualną treść i wskazówki; nowe przygotowanie rozpocznie się na podstawie bieżącej wersji.', primary: edit };
  if (code === 'RECIPE_MODEL_CHANGED') return { ...base, tone: 'warning', title: 'Zmieniła się konfiguracja generatora', description: 'Zachowaliśmy wcześniejszy wynik i historię prób. Otwórz przepis, sprawdź wskazówki i zapisz bieżącą wersję przed nowym opracowaniem.', reason, primary: edit };
  if (recovery?.status === 'exhausted') return { ...base, tone: 'warning', title: 'Automatyczne poprawki nie wystarczyły',
    description: recovery.canResume
      ? 'Wykorzystano dwie automatyczne poprawki. Możesz ponownie odczytać i sprawdzić zapisany wynik bez kolejnej generacji. Jeśli nadal zawiera błędy, popraw wskazówki przed nowym opracowaniem.'
      : 'Wykorzystaliśmy limit prób dla tego zgłoszenia. Sprawdź wskazane pola i popraw wskazówki przed nowym opracowaniem. Twój szkic pozostaje zachowany.',
    reason, primary: recovery.canResume ? { action: 'recover', label: 'Sprawdź zapisany wynik' } : edit };
  if (recovery?.status === 'blocked') return { ...base, tone: 'warning', title: 'Przygotowanie przepisu zostało zatrzymane', description: recovery.canResume ? 'Możesz bezpiecznie kontynuować to samo zgłoszenie. System zachowa historię i limit automatycznych poprawek.' : 'Sprawdź przyczynę poniżej i popraw wskazówki przepisu. Dalsze przygotowanie wymaga usunięcia tej przeszkody.', reason, primary: recovery.canResume ? { action: 'recover', label: 'Dokończ automatycznie' } : edit };
  if (job.kind === 'recipe' && job.status === 'failed' && /RESULT_INVALID|RESEARCH_SOURCE_INVALID/.test(code)) return { ...base, tone: 'warning', title: 'Przepis wymaga uzupełnienia przed zapisaniem', description: 'Wynik nie przeszedł sprawdzenia kompletności. System może poprawić wykryte braki w ograniczonej liczbie prób. Potem otrzymasz pełny przepis do przeczytania i akceptacji.', primary: recovery?.canResume ? { action: 'recover', label: 'Dokończ automatycznie' } : edit };
  if (job.status === 'cancelled') return { ...base, tone: 'warning', title: 'Przygotowanie zostało anulowane', description: 'Twój przepis jest zachowany. Wróć do niego, sprawdź wskazówki i rozpocznij przygotowanie, kiedy będzie potrzebne.', primary: edit };
  if (job.status === 'failed') return { ...base, tone: 'warning', title: 'Nie udało się zakończyć przygotowania', description: 'Twój szkic jest zachowany. Sprawdź wskazówki i spróbuj przygotować przepis ponownie. Jeśli problem się powtórzy, sprawdź konfigurację generatora w ustawieniach.', reason: reason || (job.errorMessage ? issueMessage(job.errorMessage) : undefined), primary: edit };
  return null;
}
