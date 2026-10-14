/**
 * Versioned migration/result state for the import Actor.
 *
 * The legacy `MIGRATION_STATE` record (`{ results, processedIndex }`) tracked
 * only COMPLETED companies: a migration/resurrection mid-company reprocessed
 * that company from its first lead, REPEATING CRM writes. The v2 state adds:
 *
 *   - an ACTIVE-COMPANY marker written BEFORE the company's first CRM
 *     operation, carrying the confirmed running counts;
 *   - a per-lead progress index updated after each completed contact;
 *   - a FINALIZING phase holding the finished company row between its state
 *     persistence and its dataset publication;
 *   - a TERMINAL marker kept after completion so a resurrected run cannot
 *     restart processing — carrying the settled Actor status (reason,
 *     failure flag, failure message) so resurrection reproduces it.
 *
 * Resume policy (user-settled: stop incomplete, never replay):
 *   - clean boundary        → continue with the next company;
 *   - active `processing`   → publish the company row from the retained
 *                             counts with `resultsComplete: false`,
 *                             `terminalReason: 'interrupted'` — its CRM
 *                             writes are NEVER repeated;
 *   - active `finalizing`  → publish the stored final row, advance;
 *   - legacy state          → completed results preserved as LEGACY rows
 *                             (v1 only advanced the index after
 *                             publication), resumed at the same index;
 *   - terminal              → preserve the settled outcome, re-emit OUTPUT
 *                             and the settled Actor status.
 *
 * This is checkpoint evidence for recovery, NOT a transaction with HubSpot: a
 * hard kill between a CRM write and its state persistence can still leave an
 * unaccounted write — that is reported as incomplete evidence
 * (`resultsComplete: false`), never as zero writes.
 */

import type {
    AnyCompanyRow,
    CompanyResult,
    ContactImportStats,
    CompanySourceEvidence,
} from './types.js';

export const STATE_KEY = 'MIGRATION_STATE';

export const STATE_VERSION_2 = 2;

export type ActiveCompanyPhase = 'processing' | 'finalizing';

export interface ActiveCompanyState {
    companyIndex: number;
    companyId: string;
    companyUrl: string;
    phase: ActiveCompanyPhase;
    /** Confirmed running counts (persisted after every completed contact). */
    stats: ContactImportStats;
    /** Lead index of the last completed contact (-1 = none yet). */
    lastCompletedLeadIndex: number;
    source: CompanySourceEvidence;
    /** Set once the finished row is stored in `finalResult` (phase finalizing). */
    finalResult?: CompanyResult;
}

/**
 * Terminal marker kept after completion. Carries enough information to
 * reproduce the settled Actor status on resurrection: the terminal reason,
 * whether the settled run FAILED the Actor, and the failure message to
 * re-emit. Markers written before this shape existed lack `actorFailed`;
 * the resurrection path infers conservatively from the retained rows.
 */
export interface TerminalMarker {
    reason: string;
    resultsComplete: boolean;
    /** True when the settled run failed the Actor (early stop / zero-write failure). */
    actorFailed?: boolean;
    /** Failure message to re-emit when `actorFailed` (preserved verbatim). */
    failureMessage?: string;
    /** When the run settled (ISO). */
    settledAt?: string;
}

export interface MigrationStateV2 {
    stateVersion: number;
    startTime: string;
    nextCompanyIndex: number;
    /** Company rows of either generation (v2 rows or normalized legacy v1 rows). */
    completedCompanies: AnyCompanyRow[];
    active?: ActiveCompanyState;
    terminal?: TerminalMarker;
}

export const newMigrationState = (startTime: Date): MigrationStateV2 => ({
    stateVersion: STATE_VERSION_2,
    startTime: startTime.toISOString(),
    nextCompanyIndex: 0,
    completedCompanies: [],
});

/** Deep-clone a state snapshot for queue-time persistence. */
export const cloneStateSnapshot = (state: MigrationStateV2): MigrationStateV2 => {
    try {
        return structuredClone(state);
    } catch {
        return JSON.parse(JSON.stringify(state)) as MigrationStateV2;
    }
};

/**
 * Normalize one raw legacy-v1 company row (the v1 importer wrote no
 * `resultVersion`, no `failed`, and no completeness fields). Field access is
 * defensive: only known-numeric counters are carried through; anything absent
 * or non-numeric stays absent rather than fabricating a value. The returned
 * row keeps its LEGACY identity (no `resultVersion`) so `isLegacyCompanyRow`
 * stays true and consumers never read it as v2.
 */
export const normalizeLegacyCompanyRow = (row: unknown): AnyCompanyRow | null => {
    if (typeof row !== 'object' || row === null) return null;
    const record = row as Record<string, unknown>;

    const count = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;

    if (typeof record.companyId !== 'string') return null;

    return {
        kind: 'company',
        companyId: record.companyId,
        companyUrl: typeof record.companyUrl === 'string' ? record.companyUrl : '',
        status: record.status === 'skipped' || record.status === 'failed'
            ? record.status
            : 'imported',
        created: count(record.created) ?? 0,
        updated: count(record.updated) ?? 0,
        skipped: count(record.skipped) ?? 0,
        rowsTotal: count(record.rowsTotal) ?? 0,
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
    };
};

/**
 * Parse a saved state record. Returns null for an unrecognized shape (the
 * caller starts fresh — logged, because a fresh start after an unreadable
 * state can repeat writes for uncompleted companies).
 *
 * Legacy v1 records (`{ results, processedIndex }`) convert with their rows
 * NORMALIZED (`normalizeLegacyCompanyRow`): v1 completed companies were all
 * published before the index advanced, so their rows are preserved as
 * legacy-generation rows — their `skipped` may include failed writes and is
 * never re-labelled as v2 intentional skips.
 */
export const parseSavedState = (raw: unknown): MigrationStateV2 | null => {
    if (typeof raw !== 'object' || raw === null) return null;

    const record = raw as Record<string, unknown>;

    if (record.stateVersion === STATE_VERSION_2) {
        if (typeof record.nextCompanyIndex !== 'number' || !Array.isArray(record.completedCompanies)) {
            return null;
        }
        return raw as MigrationStateV2;
    }

    // Legacy v1: results array + processed index.
    if (Array.isArray(record.results) && typeof record.processedIndex === 'number') {
        const completed = record.results
            .map((row) => normalizeLegacyCompanyRow(row))
            .filter((row): row is AnyCompanyRow => row !== null);
        return {
            stateVersion: STATE_VERSION_2,
            startTime: new Date().toISOString(),
            nextCompanyIndex: record.processedIndex,
            completedCompanies: completed,
        };
    }

    return null;
};

/** Initial per-company stats. */
export const emptyStats = (rowsTotal = 0): ContactImportStats => ({
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    rowsTotal,
});