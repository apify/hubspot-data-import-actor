/**
 * Run- and company-level outcome derivation for the import Actor (result v2).
 *
 * Changes from v1:
 *   - the old global "no company matched", "no verification data" and "no
 *     item carries a leadsEnrichment array" preflight throws are gone —
 *     mismatch, missing verification evidence and missing lead fields are
 *     per-company classifications (see `source-results.ts`) that surface as
 *     evidence rows instead of crashing before any row is written;
 *   - `deriveCompanyOutcome` replaces `deriveCompanyStatus` as the single
 *     classification authority, including explicit completeness;
 *   - `assertSomeWritesSucceeded` consumes the v2 counters (`failed` counted
 *     separately from `skipped`).
 */

import type {
    CompanyOutcome,
    CompanySourceEvidence,
    CompanyStatus,
    CompanyTerminalReason,
    ContactImportStats,
} from './types.js';
import type { SourceDatasetEvidence, SourceItemEvidence } from './source-results.js';

/**
 * Global dataset usability preflight. A dataset that cannot be read, or is
 * empty, cannot prove a VALID empty enrichment — those are run-level
 * failures, decided BEFORE any company processing.
 *
 * A dataset whose items carry no `leadsEnrichment` arrays at all is NOT a
 * run-level failure anymore: it is per-company source evidence, classified
 * by `classifyCompanySource` (`source_invalid`) and surfaced as deterministic
 * per-company failure rows — the old global crash discarded evidence before
 * any row was written.
 */
export const assertDatasetUsable = (
    datasetId: string,
    evidence: SourceDatasetEvidence,
): void => {
    if (!evidence.readComplete) {
        throw new Error(`Failed reading dataset "${datasetId}": ${evidence.readError ?? 'unknown error'}`);
    }

    if (evidence.totalItems === 0) {
        throw new Error(
            `Dataset "${datasetId}" is empty. A valid empty enrichment cannot be verified from an empty dataset — nothing was imported.`,
        );
    }
};

/** Row-level source-evidence block (counts only, safe against null). */
export const companySourceEvidence = (
    evidence: SourceItemEvidence | null,
): CompanySourceEvidence => ({
    matchedItems: evidence?.matchedItems ?? 0,
    validLeadRows: evidence?.validLeadRows.length ?? 0,
    invalidLeadRows: evidence?.invalidLeadRows ?? 0,
    readComplete: true,
});

/**
 * Derive the per-company outcome/status/completeness from confirmed stats.
 *
 * Outcome policy (result v2):
 *   - writes (created+updated) with zero failures and zero recorded errors →
 *     `complete`; an all-intentional-skip run is also `complete` (terminal
 *     reason `no_change`);
 *   - zero valid lead rows on a VALID empty source → `no_results`;
 *   - writes PLUS failures or a recorded error → `partial`;
 *   - no writes with failures/errors → `failed`.
 *
 * `processingComplete: false` (stopped mid-company: auth, unexpected error,
 * progress-persist failure, interruption) keeps whatever the confirmed stats
 * say, but marks `resultsComplete: false` — the last operation's outcome is
 * ambiguous, so absent evidence is never reported as zero writes.
 */
export const deriveCompanyOutcome = (input: {
    stats: ContactImportStats;
    processingComplete: boolean;
    sourceValid: boolean;
    /** Distinguishes the no-URL case (legacy status 'skipped') from other invalid sources. */
    noCompanyUrl?: boolean;
}): {
    outcome: CompanyOutcome;
    status: CompanyStatus;
    resultsComplete: boolean;
    terminalReason: CompanyTerminalReason;
} => {
    const { stats, processingComplete } = input;
    const writes = stats.created + stats.updated;
    const hadError = stats.error != null;

    if (!input.sourceValid) {
        return {
            outcome: 'failed',
            // No URL supplied → legacy 'skipped' view; any other invalid
            // source/unmatched company → 'failed'.
            status: input.noCompanyUrl ? 'skipped' : 'failed',
            resultsComplete: true, // nothing was attempted — knowledge is complete
            terminalReason: 'source_invalid',
        };
    }

    if (!processingComplete) {
        return {
            // Confirmed writes with an interrupted remainder = partial;
            // zero confirmed writes = failed. Either way the evidence is
            // explicitly incomplete — never "zero writes".
            outcome: writes > 0 ? 'partial' : 'failed',
            status: writes > 0 ? 'imported' : 'failed',
            resultsComplete: false,
            terminalReason: 'interrupted',
        };
    }

    if (stats.rowsTotal === 0) {
        return {
            outcome: 'no_results',
            status: 'imported',
            resultsComplete: true,
            terminalReason: 'no_results',
        };
    }

    if (writes === 0 && stats.failed === 0 && !hadError) {
        return {
            outcome: 'complete',
            status: 'imported',
            resultsComplete: true,
            terminalReason: 'no_change',
        };
    }

    if (writes > 0 && (stats.failed > 0 || hadError)) {
        return {
            outcome: 'partial',
            status: 'imported',
            resultsComplete: true,
            terminalReason: 'complete',
        };
    }

    if (writes === 0) {
        return {
            outcome: 'failed',
            status: 'failed',
            resultsComplete: true,
            terminalReason: 'complete',
        };
    }

    return {
        outcome: 'complete',
        status: 'imported',
        resultsComplete: true,
        terminalReason: 'complete',
    };
};

/**
 * Run-level "zero writes" assertion: no successful write anywhere AND at
 * least one failed contact or company error → the run fails (after its
    * evidence rows and OUTPUT have been persisted). Zero writes with no
 * failures at all (every row intentionally skipped, or valid no-results) is a
 * SUCCESS.
 */
export const assertSomeWritesSucceeded = (totals: {
    totalCreated: number;
    totalUpdated: number;
    totalFailed: number;
    anyCompanyHadError: boolean;
}): void => {
    const writes = totals.totalCreated + totals.totalUpdated;
    const zeroWrites = writes === 0;
    if (zeroWrites && (totals.totalFailed > 0 || totals.anyCompanyHadError)) {
        throw new Error(
            `All lead writes failed. 0 created, 0 updated, ${totals.totalFailed} failed across all companies. `
            + 'See per-company errors in dataset.',
        );
    }
};