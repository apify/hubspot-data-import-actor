import { Actor, log } from 'apify';
import type {
    ActorOutput,
    CompanyResult,
    CompanyTerminalReason,
} from './types.js';
import { RESULT_VERSION_2 } from './types.js';
import { validateInput } from './validation.js';
import { findDeadSources } from './utils.js';
import { processCompanyLeads, type ContactProgressSink } from './contacts.js';
import {
    classifyCompanySource,
    companyVerificationEvidenceMissing,
    readSourceDataset,
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
    emptyStats,
    newMigrationState,
    parseSavedState,
    type MigrationStateV2,
} from './result-state.js';

await Actor.init();

try {
    const input = validateInput(await Actor.getInput());
    const cleanedMappings = input.dataMappings.filter((m) => m.source?.trim() && m.target?.trim());

    const store = await Actor.openKeyValueStore();
    const dataset = await Actor.openDataset(input.datasetId);

    // --- Restore versioned state (v2; legacy v1 records convert losslessly).
    // An unrecognized record starts fresh (logged — a fresh start can repeat
    // uncompleted writes, which is why the state shape is versioned).
    const saved = await store.getValue<unknown>(STATE_KEY);
    const state: MigrationStateV2 = parseSavedState(saved) ?? newMigrationState(new Date());
    if (saved && parseSavedState(saved) === null) {
        log.warning('Unrecognized migration state — starting fresh; uncompleted companies may be repeated.');
    }
    if (state.terminal) {
        log.warning(`Resurrected after terminal state ("${state.terminal.reason}") — preserving the settled result, not restarting processing.`);
    }

    // --- Serialized state persistence: chained so the periodic
    // `persistState` event and the `migrating` handler can never interleave
    // writes or persist a stale snapshot over a newer one.
    let persistChain: Promise<void> = Promise.resolve();
    const persistState = (): Promise<void> => {
        persistChain = persistChain
            .then(() => store.setValue(STATE_KEY, state))
            .catch((err) => {
                log.warning(`Failed persisting migration state: ${err instanceof Error ? err.message : err}`);
            });
        return persistChain;
    };

    Actor.on('migrating', () => {
        log.info('Migration event received, persisting state...');
        return persistState();
    });
    Actor.on('persistState', () => {
        void persistState();
    });

    // --- Read the source dataset into per-URL evidence. ----------------------
    log.info(`Starting leads-contact import for ${input.companyUrlMapping.length} companies from dataset ${input.datasetId}`);
    const sourceEvidence = await readSourceDataset(dataset, input.datasetId);
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
     * repeated publication).
     */
    const sink: ContactProgressSink = async (progress) => {
        if (!state.active) return;
        state.active.stats = progress.stats;
        state.active.lastCompletedLeadIndex = progress.leadIndex;
        await persistState();
        await Actor.pushData([progress.contact]);
    };

    /** Publish a deterministic company row from a resumed active-company
     * marker WITHOUT repeating its CRM writes (stop-incomplete policy). */
    const resumeActiveCompany = async (): Promise<void> => {
        const active = state.active;
        if (!active) return;

        if (active.phase === 'finalizing' && active.finalResult) {
            await Actor.pushData([active.finalResult]);
            state.completedCompanies.push(active.finalResult);
        } else {
            const derived = deriveCompanyOutcome({
                stats: active.stats,
                processingComplete: false,
                sourceValid: true,
            });
            const row: CompanyResult = {
                kind: 'company',
                resultVersion: RESULT_VERSION_2,
                resultId: `company:${active.companyId}:${active.companyIndex}`,
                companyIndex: active.companyIndex,
                companyId: active.companyId,
                companyUrl: active.companyUrl,
                status: derived.status,
                outcome: derived.outcome,
                ...active.stats,
                resultsComplete: false,
                terminalReason: 'interrupted',
                source: active.source,
            };
            await Actor.pushData([row]);
            state.completedCompanies.push(row);
        }

        state.nextCompanyIndex = active.companyIndex + 1;
        state.active = undefined;
        await persistState();
    };

    /** Persist + publish one finished company row (finalizing boundary). */
    const publishCompanyRow = async (row: CompanyResult): Promise<void> => {
        // FINALIZING: the finished row travels in the state BEFORE its dataset
        // publication, so a crash between the two resumes by republishing the
        // stored row instead of repeating CRM work.
        if (state.active) {
            state.active = { ...state.active, phase: 'finalizing', finalResult: row };
        }
        await persistState();
        await Actor.pushData([row]);
        state.completedCompanies.push(row);
        state.nextCompanyIndex = row.companyIndex + 1;
        state.active = undefined;
        await persistState();
    };

    await resumeActiveCompany();

    for (let i = state.nextCompanyIndex; i < input.companyUrlMapping.length; i++) {
        if (state.terminal) break;

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
            await publishCompanyRow({
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
            });
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
            await publishCompanyRow({
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
            });
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
                error: 'onlyVerifiedEmails is enabled but no email-bearing lead carries an emailVerification block — '
                    + 'the enrichment run was likely produced with email verification disabled.',
                resultsComplete: true,
                terminalReason: 'verification_data_missing',
                source: companySourceEvidence(classification.evidence),
            });
            continue;
        }

        log.info(`Processing ${leads.length} lead row(s) for company ${companyId}...`);

        // ACTIVE marker BEFORE the first CRM operation: an interruption here
        // resumes by publishing retained counts, never by replaying writes.
        state.active = {
            companyIndex: i,
            companyId,
            companyUrl,
            phase: 'processing',
            stats: emptyStats(leads.length),
            lastCompletedLeadIndex: -1,
            source: companySourceEvidence(classification.evidence),
        };
        await persistState();

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

        await publishCompanyRow({
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
        });

        if (!result.processingComplete) {
            // Auth/persist failures stop the RUN (evidence is persisted
            // above); remaining companies would fail identically.
            runStopReason = terminalReason;
            break;
        }
    }

    // --- Run-level OUTPUT (persisted on controlled failures too) ------------
    const completed = state.completedCompanies;
    const totalCreated = completed.reduce((sum, r) => sum + r.created, 0);
    const totalUpdated = completed.reduce((sum, r) => sum + r.updated, 0);
    const totalSkipped = completed.reduce((sum, r) => sum + r.skipped, 0);
    const totalFailed = completed.reduce((sum, r) => sum + r.failed, 0);
    const totalRows = completed.reduce((sum, r) => sum + r.rowsTotal, 0);
    const anyCompanyHadError = completed.some((r) => r.error != null || r.failed > 0);
    const resultsComplete = sourceEvidence.readComplete
        && completed.every((r) => r.resultsComplete)
        && !runStopReason;

    const terminalReason: CompanyTerminalReason = runStopReason ?? 'complete';
    const endTime = new Date();
    const duration = (endTime.getTime() - startTime.getTime()) / 1_000;

    const output: ActorOutput = {
        resultVersion: RESULT_VERSION_2,
        totalCompanies: input.companyUrlMapping.length,
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalFailed,
        totalRows,
        unmatchedCompanies: completed
            .filter((r) => r.terminalReason === 'unmatched_company')
            .map((r) => r.companyUrl),
        results: completed,
        datasetId: input.datasetId,
        resultsComplete,
        terminalReason,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
    };

    // Terminal marker BEFORE the OUTPUT: a resurrection after this point
    // preserves the settled result instead of restarting processing.
    state.terminal = { reason: terminalReason, resultsComplete };
    await persistState();
    await Actor.setValue('OUTPUT', output);

    log.info('Leads-contact import finished.', {
        resultVersion: RESULT_VERSION_2,
        stateVersion: STATE_VERSION_2,
        totalCompanies: input.companyUrlMapping.length,
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalFailed,
        totalRows,
        resultsComplete,
        terminalReason,
        duration,
    });

    // Actor status policy: stopping early (auth/persist) fails the run WITH
    // its evidence persisted; zero writes plus real failures fails the run;
    // intentional-skip-only and valid no-results runs SUCCEED.
    if (runStopReason) {
        await Actor.fail(`Import stopped early (${runStopReason}) — confirmed evidence rows were persisted.`);
    } else {
        assertSomeWritesSucceeded({ totalCreated, totalUpdated, totalFailed, anyCompanyHadError });
    }
} catch (err) {
    log.error('Import failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    await Actor.fail(errorMessage);
} finally {
    await Actor.exit();
}