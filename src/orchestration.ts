/**
 * Orchestration for the import Actor run — the whole per-company loop,
 * checkpoint/recovery policy, run-level OUTPUT and Actor status policy.
 *
 * Extracted from `main.ts` so the recovery boundaries are testable without
 * the Apify SDK: `main.ts` wires the SDK (input, KV store, dataset, pushData,
 * OUTPUT, events, fail) into `ActorRuntime`, and everything below runs
 * against that interface.
 *
 * v2 policy implemented here:
 *   - state persistence REJECTS to its caller (queued snapshot serialized so
 *     the periodic `persistState`/`migrating` events can never overwrite a
 *     newer snapshot with a stale one); a caller whose checkpoint failed stops
 *     all further CRM writes;
 *   - the active-company marker is durably persisted BEFORE the company's
 *     first CRM operation — an interruption resumes by publishing the
 *     retained counts (`resultsComplete: false`), never by replaying writes;
 *   - interrupted companies carry an explicit legacy-compatible `error` so
 *     downstream consumers (the backend run finalizer reads `error`) can
 *     never mistake an interrupted company for a clean one;
 *   - the terminal marker carries the settled Actor status (failure flag +
 *     message), so a resurrected run reproduces the settled outcome instead
 *     of silently converting it into a success;
 *   - legacy (v1) resumed rows stay legacy: their unknown failed/skipped
 *     split stays explicit and never becomes fabricated v2 certainty.
 */

import { log } from 'apify';

import type {
    ActorOutput,
    AnyCompanyRow,
    CompanyResult,
    CompanyTerminalReason,
} from './types.js';
import { RESULT_VERSION_2, isLegacyCompanyRow } from './types.js';
import type { ValidatedActorInput } from './validation.js';
import { findDeadSources } from './utils.js';
import { processCompanyLeads, type ContactProgressSink } from './contacts.js';
import {
    classifyCompanySource,
    companyVerificationEvidenceMissing,
    readSourceDataset,
    type SourceDatasetLike,
} from './source-results.js';
import {
    assertDatasetUsable,
    assertSomeWritesSucceeded,
    companySourceEvidence,
    deriveCompanyOutcome,
} from './failStates.js';
import {
    STATE_KEY,
    STATE_VERSION_2,
    cloneStateSnapshot,
    emptyStats,
    newMigrationState,
    parseSavedState,
    type MigrationStateV2,
} from './result-state.js';

/** Key-value store surface the orchestration needs. */
export interface KeyValueStoreLike {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
}

/** Everything the orchestration touches on the Apify platform. */
export interface ActorRuntime {
    /** Already-validated actor input. */
    input: ValidatedActorInput;
    /** Migration/result state store (the run's own KV namespace). */
    kv: KeyValueStoreLike;
    /** Source dataset to read enrichment evidence from. */
    dataset: SourceDatasetLike;
    /** Publish result rows (per-contact and per-company). */
    pushData(rows: unknown[]): Promise<void>;
    /** Persist the run-level OUTPUT record. */
    setOutput(output: ActorOutput): Promise<void>;
    /** Register the periodic persistence handlers (`migrating` + `persistState`). */
    onPersistEvent(handler: () => Promise<void>): void;
    /** Fail the Actor run (terminal, with the message surfaced to the user). */
    failRun(message: string): Promise<void>;
    /** Current time (injectable for tests). */
    now(): Date;
}

/** Legacy-compatible error surfaced on every interrupted company row. */
const INTERRUPTED_COMPANY_ERROR = 'Processing was interrupted before this company completed '
    + '(migration/resurrection). Confirmed counts are retained; the remaining leads were never attempted '
    + 'and are NOT replayed.';

/**
 * Run the whole import. Persists evidence rows + OUTPUT on controlled
 * failures, then either fails the run (early stop / zero-write failure) or
 * returns normally (success — including valid no-results and all-skip runs).
 */
export const runImport = async (rt: ActorRuntime): Promise<void> => {
    const { input } = rt;
    const cleanedMappings = input.dataMappings.filter((m) => m.source?.trim() && m.target?.trim());

    // --- Restore versioned state (v2; legacy v1 records convert with their
    // rows normalized as LEGACY rows). An unrecognized record starts fresh
    // (logged — a fresh start can repeat uncompleted writes, which is why
    // the state shape is versioned).
    const saved = await rt.kv.get(STATE_KEY);
    const state: MigrationStateV2 = parseSavedState(saved) ?? newMigrationState(rt.now());
    if (saved !== undefined && saved !== null && parseSavedState(saved) === null) {
        log.warning('Unrecognized migration state — starting fresh; uncompleted companies may be repeated.');
    }

    // --- Serialized, CALLER-REJECTING state persistence. -------------------
    // A SNAPSHOT is taken at queue time (later mutations never travel inside
    // an in-flight checkpoint), writes are chained (the periodic persistState
    // event and explicit checkpoints can never interleave or persist a stale
    // snapshot over a newer one), the chain SURVIVES a failed write (the next
    // write is still attempted), and the queued promise REJECTS to its caller
    // so a failed checkpoint stops all further CRM work.
    let persistChain: Promise<void> = Promise.resolve();
    const persistState = (): Promise<void> => {
        const snapshot = cloneStateSnapshot(state);
        const attempt = persistChain.then(() => rt.kv.set(STATE_KEY, snapshot));
        persistChain = attempt.catch(() => {
            // The chain continues past a failed write so the NEXT checkpoint
            // (e.g. the terminal marker after a controlled stop) is still
            // attempted; the failure itself is surfaced via `attempt`.
        });
        return attempt;
    };

    const persistStateBestEffort = async (context: string): Promise<boolean> => {
        try {
            await persistState();
            return true;
        } catch (err) {
            log.warning(`Failed persisting migration state (${context}): ${err instanceof Error ? err.message : err}`);
            return false;
        }
    };

    rt.onPersistEvent(() => persistState().catch((err) => {
        log.warning(`Periodic migration-state persistence failed: ${err instanceof Error ? err.message : err}`);
    }));

    // --- Terminal resurrection: preserve the settled outcome. --------------
    // The previous incarnation settled this run and kept its terminal marker;
    // reproduce its OUTPUT and Actor status without reading the source
    // dataset and without touching the CRM.
    if (state.terminal) {
        const marker = state.terminal;
        log.warning(`Resurrected after terminal state ("${marker.reason}") — preserving the settled result, not restarting processing.`);
        const output = buildRunOutput({
            input,
            state,
            resultsComplete: marker.resultsComplete,
            terminalReason: marker.reason as CompanyTerminalReason,
            endTime: rt.now(),
        });
        await rt.setOutput(output);
        // A pre-shape marker carries no failure flag: infer conservatively
        // from the retained rows (zero writes + failures ⇒ the run failed).
        const inferredFailure = marker.actorFailed === undefined
            ? inferSettledFailureMessage(state)
            : undefined;
        const actorFailed = marker.actorFailed ?? inferredFailure !== undefined;
        if (actorFailed) {
            await rt.failRun(
                marker.failureMessage
                ?? inferredFailure
                ?? `Import previously failed (${marker.reason}); settled evidence was preserved.`,
            );
        }
        return;
    }

    // --- Read the source dataset into per-URL evidence. ----------------------
    log.info(`Starting leads-contact import for ${input.companyUrlMapping.length} companies from dataset ${input.datasetId}`);
    const sourceEvidence = await readSourceDataset(rt.dataset, input.datasetId);
    assertDatasetUsable(input.datasetId, sourceEvidence);
    log.info(
        `Read ${sourceEvidence.totalItems} item(s) from dataset, mapped ${sourceEvidence.byUrl.size} unique URL(s)`,
    );

    // With no source whitelist, a typo'd mapping source is silently skipped on
    // every row — surface it once per run (existing diagnostic behavior).
    const allLeads = [...sourceEvidence.byUrl.values()]
        .flatMap((perUrl) => perUrl.validLeadRows) as unknown as Record<string, unknown>[];
    const deadSources = findDeadSources(allLeads, cleanedMappings.map((m) => m.source));
    if (deadSources.length > 0) {
        log.warning(`Mapping sources resolved on no dataset row — check for typos: ${deadSources.map((s) => `"${s}"`).join(', ')}`);
    }

    if (input.onlyVerifiedEmails && allLeads.length > 0 && !allLeads.some((l) => (l as { emailVerification?: unknown }).emailVerification)) {
        log.warning('onlyVerifiedEmails is enabled but no lead carries an email verification object — email-bearing companies will fail with configuration evidence.');
    }

    // --- Per-company processing ---------------------------------------------
    const startTime = new Date(state.startTime);
    let runStopReason: CompanyTerminalReason | undefined;

    /**
     * Progress sink: persist the confirmed checkpoint FIRST (a crash after
     * the CRM write but before publication still leaves the count), then
     * publish the completed contact row (stable resultId deduplicates any
     * repeated publication). A sink failure REJECTS into `contacts.ts`,
     * which stops all further CRM writes for this company.
     */
    const sink: ContactProgressSink = async (progress) => {
        if (!state.active) return;
        state.active.stats = progress.stats;
        state.active.lastCompletedLeadIndex = progress.leadIndex;
        await persistState();
        await rt.pushData([progress.contact]);
    };

    /** Publish a deterministic company row from a resumed active-company
     * marker WITHOUT repeating its CRM writes (stop-incomplete policy). */
    const resumeActiveCompany = async (): Promise<void> => {
        const active = state.active;
        if (!active) return;

        let row: CompanyResult;
        if (active.phase === 'finalizing' && active.finalResult) {
            // The finished row was durably stored before its publication was
            // interrupted — republish the SAME row (same resultId).
            row = active.finalResult;
        } else {
            const derived = deriveCompanyOutcome({
                stats: active.stats,
                processingComplete: false,
                sourceValid: true,
            });
            row = {
                kind: 'company',
                resultVersion: RESULT_VERSION_2,
                resultId: `company:${active.companyId}:${active.companyIndex}`,
                companyIndex: active.companyIndex,
                companyId: active.companyId,
                companyUrl: active.companyUrl,
                status: derived.status,
                outcome: derived.outcome,
                ...active.stats,
                // Explicit legacy-compatible error: consumers reading `error`
                // (the backend run finalizer) must never mistake an
                // interrupted company for a clean one.
                error: active.stats.error ?? INTERRUPTED_COMPANY_ERROR,
                resultsComplete: false,
                terminalReason: 'interrupted',
                source: active.source,
            };
        }

        await rt.pushData([row]);
        state.completedCompanies.push(row);
        state.nextCompanyIndex = active.companyIndex + 1;
        state.active = undefined;
        // Durable advance so a restart does not republish; a failure here
        // stops the run (the next company's marker would fail identically).
        if (!await persistStateBestEffort('resume advance')) {
            runStopReason ??= 'progress_persist_failed';
        }
    };

    /**
     * Persist + publish one finished company row (finalizing boundary).
     * Returns whether BOTH state writes survived; a non-durable publication
     * stops the run (the row itself still travels to the dataset — evidence
     * beats silence).
     */
    const publishCompanyRow = async (row: CompanyResult): Promise<boolean> => {
        // FINALIZING: the finished row travels in the state BEFORE its dataset
        // publication, so a crash between the two resumes by republishing the
        // stored row instead of repeating CRM work.
        if (state.active) {
            state.active = { ...state.active, phase: 'finalizing', finalResult: row };
        }
        const durableBefore = await persistStateBestEffort('finalizing marker');
        await rt.pushData([row]);
        state.completedCompanies.push(row);
        state.nextCompanyIndex = row.companyIndex + 1;
        state.active = undefined;
        const durableAfter = await persistStateBestEffort('company advance');
        return durableBefore && durableAfter;
    };

    await resumeActiveCompany();

    for (let i = state.nextCompanyIndex; i < input.companyUrlMapping.length; i++) {
        if (runStopReason) break;

        const { companyId } = input.companyUrlMapping[i];
        const companyUrl = input.companyUrlMapping[i].url?.trim() ?? '';
        const classification = classifyCompanySource(companyUrl, sourceEvidence.byUrl);

        if (classification.kind === 'invalid_source') {
            // Deterministic company failure (no URL / unmatched / malformed
            // source) — surfaced as an evidence row, not a run-level crash.
            log.warning(`Company ${companyId}: ${classification.reason}`);
            const derived = deriveCompanyOutcome({
                stats: emptyStats(0),
                processingComplete: true,
                sourceValid: false,
                noCompanyUrl: classification.reasonCode === 'no_company_url',
            });
            if (!await publishCompanyRow({
                kind: 'company',
                resultVersion: RESULT_VERSION_2,
                resultId: `company:${companyId}:${i}`,
                companyIndex: i,
                companyId,
                companyUrl,
                status: derived.status,
                outcome: derived.outcome,
                ...emptyStats(0),
                error: classification.reason,
                resultsComplete: true,
                terminalReason: classification.reasonCode,
                source: companySourceEvidence(classification.evidence),
            })) {
                runStopReason ??= 'progress_persist_failed';
                break;
            }
            continue;
        }

        if (classification.kind === 'valid_empty') {
            // Explicit `leadsEnrichment: []` on a complete read — a VALID
            // empty enrichment: successful no-results, not an error.
            log.info(`Company ${companyId}: matched item carries an explicit empty leadsEnrichment array`);
            const derived = deriveCompanyOutcome({
                stats: emptyStats(0),
                processingComplete: true,
                sourceValid: true,
            });
            if (!await publishCompanyRow({
                kind: 'company',
                resultVersion: RESULT_VERSION_2,
                resultId: `company:${companyId}:${i}`,
                companyIndex: i,
                companyId,
                companyUrl,
                status: derived.status,
                outcome: derived.outcome,
                ...emptyStats(0),
                resultsComplete: true,
                terminalReason: 'no_results',
                source: companySourceEvidence(classification.evidence),
            })) {
                runStopReason ??= 'progress_persist_failed';
                break;
            }
            continue;
        }

        const leads = classification.evidence.validLeadRows;

        if (input.onlyVerifiedEmails && companyVerificationEvidenceMissing(leads)) {
            // Email-bearing leads with no verification evidence anywhere —
            // the enrichment run likely had verification disabled. A
            // configuration error for this company, not a global crash.
            log.warning(
                `Company ${companyId}: onlyVerifiedEmails is enabled but no email-bearing lead carries an emailVerification block — nothing would be imported.`,
            );
            if (!await publishCompanyRow({
                kind: 'company',
                resultVersion: RESULT_VERSION_2,
                resultId: `company:${companyId}:${i}`,
                companyIndex: i,
                companyId,
                companyUrl,
                status: 'failed',
                outcome: 'failed',
                ...emptyStats(leads.length),
                error: 'onlyVerifiedEmails is enabled but no email-bearing lead carries an emailVerification block — '
                    + 'the enrichment run was likely produced with email verification disabled.',
                resultsComplete: true,
                terminalReason: 'verification_data_missing',
                source: companySourceEvidence(classification.evidence),
            })) {
                runStopReason ??= 'progress_persist_failed';
                break;
            }
            continue;
        }

        log.info(`Processing ${leads.length} lead row(s) for company ${companyId}...`);

        // ACTIVE marker BEFORE the first CRM operation — and it must be
        // DURABLE first: without a persisted marker an interruption cannot
        // know this company was started, and a restart would replay its CRM
        // writes. A failed marker persist stops the run with NO CRM work.
        state.active = {
            companyIndex: i,
            companyId,
            companyUrl,
            phase: 'processing',
            stats: emptyStats(leads.length),
            lastCompletedLeadIndex: -1,
            source: companySourceEvidence(classification.evidence),
        };
        if (!await persistStateBestEffort('active-company marker')) {
            log.warning(`Company ${companyId}: progress state could not be persisted — no CRM writes will be attempted for this company.`);
            await publishCompanyRow({
                kind: 'company',
                resultVersion: RESULT_VERSION_2,
                resultId: `company:${companyId}:${i}`,
                companyIndex: i,
                companyId,
                companyUrl,
                status: 'failed',
                outcome: 'failed',
                ...emptyStats(leads.length),
                error: 'Progress state could not be persisted before processing — no CRM writes were attempted for this company.',
                resultsComplete: true,
                terminalReason: 'progress_persist_failed',
                source: companySourceEvidence(classification.evidence),
            }).catch(() => undefined);
            runStopReason ??= 'progress_persist_failed';
            break;
        }

        const result = await processCompanyLeads(
            input.hubspotAccessToken,
            companyId,
            i,
            leads,
            cleanedMappings,
            input.deduplication,
            input.onlyVerifiedEmails,
            sink,
        );

        const derived = deriveCompanyOutcome({
            stats: result.stats,
            processingComplete: result.processingComplete,
            sourceValid: true,
        });

        const terminalReason: CompanyTerminalReason = result.processingComplete
            ? derived.terminalReason
            : result.stopReason === 'auth_failed'
                ? 'auth_failed'
                : result.stopReason === 'progress_persist_failed'
                    ? 'progress_persist_failed'
                    : 'interrupted';

        if (!await publishCompanyRow({
            kind: 'company',
            resultVersion: RESULT_VERSION_2,
            resultId: `company:${companyId}:${i}`,
            companyIndex: i,
            companyId,
            companyUrl,
            status: derived.status,
            outcome: derived.outcome,
            ...result.stats,
            resultsComplete: derived.resultsComplete,
            terminalReason,
            source: companySourceEvidence(classification.evidence),
        })) {
            runStopReason ??= 'progress_persist_failed';
            break;
        }

        if (!result.processingComplete) {
            // Auth/persist failures stop the RUN (evidence is persisted
            // above); remaining companies would fail identically.
            runStopReason = terminalReason;
            break;
        }
    }

    // --- Run-level OUTPUT (persisted on controlled failures too) ------------
    const resultsComplete = sourceEvidence.readComplete
        && state.completedCompanies.every((row) => !isLegacyCompanyRow(row) && row.resultsComplete)
        && !runStopReason;

    const terminalReason: CompanyTerminalReason = runStopReason ?? 'complete';
    await finalizeRun(rt, state, input, persistStateBestEffort, {
        resultsComplete,
        terminalReason,
        runStopReason,
        startTime,
    });
};

interface FinalizeInput {
    resultsComplete: boolean;
    terminalReason: CompanyTerminalReason;
    runStopReason?: CompanyTerminalReason;
    startTime: Date;
}

/** Compute run totals, persist the terminal marker + OUTPUT, set Actor status. */
const finalizeRun = async (
    rt: ActorRuntime,
    state: MigrationStateV2,
    input: ValidatedActorInput,
    persistBestEffort: (context: string) => Promise<boolean>,
    fin: FinalizeInput,
): Promise<void> => {
    const totals = computeRunTotals(state.completedCompanies);
    const endTime = rt.now();

    // Actor status policy: stopping early (auth/persist) fails the run WITH
    // its evidence persisted; zero writes plus real failures fails the run;
    // intentional-skip-only and valid no-results runs SUCCEED.
    const failureMessage = fin.runStopReason
        ? `Import stopped early (${fin.runStopReason}) — confirmed evidence rows were persisted.`
        : zeroWriteFailureMessage(totals);
    const actorFailed = failureMessage !== undefined;

    const output = buildRunOutput({
        input,
        state,
        totals,
        resultsComplete: fin.resultsComplete,
        terminalReason: fin.terminalReason,
        endTime,
    });

    // Terminal marker BEFORE the OUTPUT: a resurrection after this point
    // preserves the settled result (incl. the Actor status) instead of
    // restarting processing. Written THROUGH the serialized persistence
    // chain so a queued periodic snapshot can never land over it. Best
    // effort: a storage outage here still emits OUTPUT and fails the run.
    state.terminal = {
        reason: fin.terminalReason,
        resultsComplete: fin.resultsComplete,
        ...(actorFailed ? { actorFailed: true, failureMessage } : { actorFailed: false }),
        settledAt: endTime.toISOString(),
    };
    await persistBestEffort('terminal marker');
    await rt.setOutput(output);

    log.info('Leads-contact import finished.', {
        resultVersion: RESULT_VERSION_2,
        stateVersion: STATE_VERSION_2,
        totalCompanies: input.companyUrlMapping.length,
        totalCreated: totals.totalCreated,
        totalUpdated: totals.totalUpdated,
        totalSkipped: totals.totalSkipped,
        totalFailed: totals.totalFailed,
        totalRows: totals.totalRows,
        legacyResultRows: totals.legacyResultRows,
        resultsComplete: output.resultsComplete,
        terminalReason: fin.terminalReason,
        duration: output.duration,
    });

    if (actorFailed && failureMessage) {
        await rt.failRun(failureMessage);
    }
};

/** Run totals over mixed-generation company rows (legacy rows stay legacy). */
export interface RunTotals {
    totalCreated: number;
    totalUpdated: number;
    totalSkipped: number;
    totalFailed: number;
    totalRows: number;
    legacyResultRows: number;
    anyCompanyHadError: boolean;
    zeroWrites: boolean;
}

/**
 * Confirmed run totals. Legacy (v1) rows contribute their KNOWN counters
 * (created/updated/skipped/rowsTotal/error); their failed/skipped split is
 * UNKNOWABLE, so they never feed `totalFailed` — they are counted separately
 * (`legacyResultRows`) and make the evidence explicitly incomplete.
 */
export const computeRunTotals = (rows: AnyCompanyRow[]): RunTotals => {
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalRows = 0;
    let legacyResultRows = 0;
    let anyCompanyHadError = false;

    for (const row of rows) {
        if (isLegacyCompanyRow(row)) {
            legacyResultRows += 1;
            totalCreated += numberOrZero(row.created);
            totalUpdated += numberOrZero(row.updated);
            totalSkipped += numberOrZero(row.skipped);
            totalRows += numberOrZero(row.rowsTotal);
            if (row.error != null) anyCompanyHadError = true;
            continue;
        }
        totalCreated += numberOrZero(row.created);
        totalUpdated += numberOrZero(row.updated);
        totalSkipped += numberOrZero(row.skipped);
        totalFailed += numberOrZero(row.failed);
        totalRows += numberOrZero(row.rowsTotal);
        if (row.error != null || row.failed > 0) anyCompanyHadError = true;
    }

    return {
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalFailed,
        totalRows,
        legacyResultRows,
        anyCompanyHadError,
        zeroWrites: totalCreated + totalUpdated === 0,
    };
};

const numberOrZero = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Assemble the run-level OUTPUT record. */
const buildRunOutput = (args: {
    input: ValidatedActorInput;
    state: MigrationStateV2;
    totals?: RunTotals;
    resultsComplete: boolean;
    terminalReason: CompanyTerminalReason;
    endTime: Date;
}): ActorOutput => {
    const totals = args.totals ?? computeRunTotals(args.state.completedCompanies);
    const startTime = new Date(args.state.startTime);
    return {
        resultVersion: RESULT_VERSION_2,
        totalCompanies: args.input.companyUrlMapping.length,
        totalCreated: totals.totalCreated,
        totalUpdated: totals.totalUpdated,
        totalSkipped: totals.totalSkipped,
        totalFailed: totals.totalFailed,
        totalRows: totals.totalRows,
        unmatchedCompanies: args.state.completedCompanies
            .filter((row) => !isLegacyCompanyRow(row) && row.terminalReason === 'unmatched_company')
            .map((row) => row.companyUrl),
        results: args.state.completedCompanies,
        datasetId: args.input.datasetId,
        // Legacy rows make the failed/skipped split unknowable — the run
        // evidence is explicitly incomplete, never silently "complete".
        resultsComplete: args.resultsComplete && totals.legacyResultRows === 0,
        terminalReason: args.terminalReason,
        ...(totals.legacyResultRows > 0 ? { legacyResultRows: totals.legacyResultRows } : {}),
        startTime: startTime.toISOString(),
        endTime: args.endTime.toISOString(),
        duration: (args.endTime.getTime() - startTime.getTime()) / 1_000,
    };
};

/**
 * Run-level "zero writes" failure message, or undefined when the evidence
 * does not prove a failed run (writes exist, or nothing failed at all).
 */
const zeroWriteFailureMessage = (totals: RunTotals): string | undefined => {
    if (!totals.zeroWrites) return undefined;
    if (totals.totalFailed <= 0 && !totals.anyCompanyHadError) return undefined;
    return `All lead writes failed. 0 created, 0 updated, ${totals.totalFailed} failed across all companies. See per-company errors in dataset.`;
};

/**
 * Conservative failure inference for pre-shape terminal markers (no
 * `actorFailed`/`failureMessage` fields): zero writes plus failures/errors
 * in the retained rows means the settled run failed.
 */
const inferSettledFailureMessage = (state: MigrationStateV2): string | undefined =>
    zeroWriteFailureMessage(computeRunTotals(state.completedCompanies));