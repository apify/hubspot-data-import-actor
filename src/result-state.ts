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
 *     restart processing.
 *
 * Resume policy (user-settled: stop incomplete, never replay):
 *   - clean boundary        → continue with the next company;
 *   - active `processing`   → publish the company row from the retained
 *                             counts with `resultsComplete: false`,
 *                             `terminalReason: 'interrupted'` — its CRM
 *                             writes are NEVER repeated;
 *   - active `finalizing`  → publish the stored final row, advance;
 *   - legacy state          → completed results preserved, no active company
 *                             (v1 only advanced the index after publication),
 *                             resumed at the same index;
 *   - terminal              → preserve the settled outcome, re-emit OUTPUT.
 *
 * This is checkpoint evidence for recovery, NOT a transaction with HubSpot: a
 * hard kill between a CRM write and its state persistence can still leave an
 * unaccounted write — that is reported as incomplete evidence
 * (`resultsComplete: false`), never as zero writes.
 */

import type { CompanyResult, ContactImportStats, CompanySourceEvidence } from './types.js';

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

export interface MigrationStateV2 {
    stateVersion: number;
    startTime: string;
    nextCompanyIndex: number;
    completedCompanies: CompanyResult[];
    active?: ActiveCompanyState;
    terminal?: {
        reason: string;
        resultsComplete: boolean;
    };
}

export const newMigrationState = (startTime: Date): MigrationStateV2 => ({
    stateVersion: STATE_VERSION_2,
    startTime: startTime.toISOString(),
    nextCompanyIndex: 0,
    completedCompanies: [],
});

/**
 * Parse a saved state record. Returns null for an unrecognized shape (the
 * caller starts fresh — logged, because a fresh start after an unreadable
 * state can repeat writes for uncompleted companies).
 *
 * Legacy v1 records (`{ results, processedIndex }`) convert losslessly:
 * their completed companies were all published before the index advanced.
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
        return {
            stateVersion: STATE_VERSION_2,
            startTime: new Date().toISOString(),
            nextCompanyIndex: record.processedIndex,
            completedCompanies: record.results as CompanyResult[],
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