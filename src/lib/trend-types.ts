import type { Localised } from './recipes';
import type { ReviewChecks } from './editorial-types';
import type { AiStatus } from './ai-types';
import type { RecipeDietId } from './recipe-diet';
export type TrendDietCounts = Record<RecipeDietId, number>;
export type TrendDietSelection = {
    target: RecipeDietId;
    selected: RecipeDietId | null;
    counts: TrendDietCounts;
    recentCounts: TrendDietCounts;
    recentWindow: number;
    fallback: boolean;
    reason: string;
};
export type TrendPhotoKind = 'hero' | 'ingredient' | 'step';
export type TrendPreparation = {
    requestKey: string;
    expectedRevision: number;
    generation: number;
    startedAt: string;
    approvedContentHash?: string;
    requestedBy?: string;
    regenerate?: { kind: TrendPhotoKind; targetId?: string };
};
export type TrendPlatform = 'instagram' | 'tiktok' | 'pinterest' | 'youtube' | 'web';
export type TrendResearch = {
    foundSources: number;
    verifiedSources: number;
    issues: Array<{ url: string; platform: TrendPlatform; reason: string }>;
};
export type TrendResearchHint = { dishKey: string; title: Localised; sourceUrls: string[] };
export type TrendSearchDiagnostics = {
    version: 1;
    model: string;
    toolCalls: number;
    queries: string[];
    retrievedUrls: number;
    discoveredCandidates: number;
    submittedSources: number;
    verifiedSources: number;
    issueCounts: Record<string, number>;
    outcome?: 'empty_discovery' | 'unverified_sources' | 'insufficient_evidence' | 'selected';
    discoveryOutcome?: 'empty_discovery' | 'unverified_sources' | 'insufficient_evidence' | 'qualified';
    reverification?: { generation: number; at: string; original: TrendSearchDiagnostics | null };
    preparation?: TrendPreparation;
};
export type TrendEvidence = {
    url: string;
    title: string;
    publisher: string;
    platform: TrendPlatform;
    publishedAt: string;
    excerpt: string;
    interestEvidence: string;
    independentKey: string;
    verifiedCreator?: string;
    verifiedInterest?: boolean;
};
export type TrendCandidate = {
    id: string;
    runId: string;
    dishKey: string;
    title: Localised;
    aliases: string[];
    rationale: string;
    /** Intended cooking category; final ingredients are checked by recipe generation. */
    diet?: RecipeDietId;
    dietSelection?: TrendDietSelection;
    sources: TrendEvidence[];
    eligible: boolean;
    rejectionReason: string | null;
    duplicateRecipeId: string | null;
    ambiguous: boolean;
    score: {
        independentSources: number;
        newestAt: string;
        platforms: number;
    };
    selected: boolean;
    research?: TrendResearch;
    verificationGeneration?: number;
    editorChoice?: { by: string; at: string };
    automaticSelection?: { basis: 'research' | 'seasonal' | 'catalog'; reason: string };
};
export type TrendRunStatus = 'queued' | 'searching' | 'generating' | 'awaiting_review' | 'no_candidate' | 'paused' | 'failed' | 'uncertain' | 'rejected' | 'published';
export type TrendRun = {
    pendingCostCount?: number;
    id: string;
    date: string;
    mode: 'daily' | 'control';
    manual?: boolean;
    selectionBasis?: 'trend' | 'editor' | 'inspiration' | 'seasonal' | 'catalog';
    status: TrendRunStatus;
    recipeId: string | null;
    expectedRevision: number | null;
    candidateId: string | null;
    selectedTitle: Localised | null;
    createdAt: string;
    updatedAt: string;
    error: string | null;
    workflowId: string | null;
    reservedUsd: string;
    chargedUsd: string;
    settledUsd?: string;
    photos: {
        ready: number;
        total: number;
        generated?: number;
        jobs?: Array<{ id: string; kind: TrendPhotoKind; targetId: string | null; status: AiStatus; errorMessage: string | null }>;
    };
    preparation?: TrendPreparation;
    sources: Record<TrendPlatform, {
        status: 'available' | 'no_evidence' | 'unavailable';
        count: number;
    }>;
    searchModel?: string;
    diagnostics?: TrendSearchDiagnostics | null;
};
export type TrendSettings = {
    enabled: boolean;
    monthlyLimitUsd: string;
    lastControlAt: string | null;
    timezone: 'Europe/Warsaw';
    scheduleUtc: '12:00';
    autoPauseReason?: string | null;
    autoPauseToken?: string | null;
};
export type TrendConfiguration = {
    configured: boolean;
    search: boolean;
    text: boolean;
    photos: boolean;
    storage: boolean;
    cron: boolean;
    controlRequired: boolean;
    recipeModel: string;
    imageModel: string;
    trendModel?: string;
};
export type TrendBudget = {
    pendingCostCount?: number;
    limitUsd: string;
    usedUsd: string;
    reservedUsd: string;
    remainingUsd: string;
};
export type TrendAutomation = {
    enabled: boolean;
    timezone: 'Europe/Warsaw';
    serverNow: string;
    nextSearchAt: string;
    readyCount: number;
    publishedToday: null | { recipeId: string; title: Localised; publishedAt: string };
    reason: string | null;
    canEnable: boolean;
};
export type TrendPublicationDay = {
    date: string; dueAt: string; status: 'pending' | 'published' | 'expired';
    generation: number; workflowId: string | null;
};
export type TrendPublicationState = TrendPublicationDay & {
    serverNow: string; canPublish: boolean; reason: string | null;
};
export type TrendPublicationResult = {
    status: 'early' | 'waiting' | 'disabled' | 'expired' | 'published';
    state: TrendPublicationState; recipeId?: string; publicationId?: string;
};
export type TrendDashboard = {
    settings: TrendSettings;
    automation: TrendAutomation;
    configuration: TrendConfiguration;
    budget: TrendBudget;
    runs: TrendRun[];
    candidates: TrendCandidate[];
};
export type TrendRunAction = {
    action: 'pause' | 'reject' | 'resume' | 'approve_and_publish' | 'reverify' | 'prepare_inspiration' | 'repair' | 'regenerate_photo';
    candidateId?: string;
    expectedRevision?: number;
    checks?: ReviewChecks;
    requestKey?: string;
    kind?: TrendPhotoKind;
    targetId?: string;
};
