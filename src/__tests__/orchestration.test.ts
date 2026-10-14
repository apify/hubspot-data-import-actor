/**
 * Orchestration regression suite — pins the recovery/result-preservation
 * contract of `runImport` against a mocked Apify runtime:
 *
 *   - a failed checkpoint stops all further CRM writes (never "writes
 *     continue with unpersisted progress");
 *   - an interrupted company is published from retained counts with an
 *     explicit legacy-compatible error — never replayed, never clean;
 *   - a resurrected terminal run reproduces the settled Actor status
 *     (an auth-failed run stays failed) without touching the CRM or the
 *     source dataset;
 *   - a readable dataset whose items carry no `leadsEnrichment` arrays
 *     produces per-company failure rows + OUTPUT, not a global crash;
 *   - resumed legacy (v1) rows stay legacy: finite totals, no fabricated
 *     v2 certainty, no replay of completed companies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateInput } from '../validation.js';
import type { ActorOutput } from '../types.js';
import { RESULT_VERSION_2 } from '../types.js';
import { STATE_KEY } from '../result-state.js';
import type { SourceDatasetLike } from '../source-results.js';
import { runImport, computeRunTotals } from '../orchestration.js';

const apiMocks = vi.hoisted(() => ({
    searchContactByEmail: vi.fn(async () => null),
    searchContactByPhone: vi.fn(async () => null),
    createContact: vi.fn(async (_token: string, properties: Record<string, string>) => `contact-${properties.email}`),
    updateContact: vi.fn(async () => undefined),
    associateContactToCompany: vi.fn(async () => undefined),
    getData: vi.fn(),
}));

vi.mock('../api.js', () => ({
    HubspotApiError: class HubspotApiError extends Error {},
    HubspotAuthError: class HubspotAuthError extends Error {},
    searchContactByEmail: apiMocks.searchContactByEmail,
    searchContactByPhone: apiMocks.searchContactByPhone,
    createContact: apiMocks.createContact,
    updateContact: apiMocks.updateContact,
    associateContactToCompany: apiMocks.associateContactToCompany,
}));

const clone = (value: unknown): unknown =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const makeInput = (overrides: {
    companies?: Array<{ companyId: string; url?: string }>;
} = {}) => validateInput({
    hubspotAccessToken: 'hs-token',
    datasetId: 'ds1',
    importMode: 'contacts',
    companyUrlMapping: overrides.companies ?? [{ companyId: 'c1', url: 'https://example.com' }],
    dataMappings: [{ source: 'email', target: 'email' }],
    deduplication: 'email',
    onlyVerifiedEmails: false,
});

interface RuntimeOptions {
    input?: ReturnType<typeof makeInput>;
    datasetPages?: Record<string, unknown>[][];
    saved?: unknown;
    /** 'always' fails every set; a number fails every set AFTER that many successful ones. */
    kvSetFails?: 'always' | number;
}

interface RuntimeHarness {
    output: ActorOutput | null;
    failures: string[];
    kvRecords: Map<string, unknown>;
    persistedStates: unknown[];
    attemptedStates: unknown[];
    run: () => Promise<void>;
    datasetReads: number;
}

const makeRuntime = (opts: RuntimeOptions = {}): RuntimeHarness => {
    const input = opts.input ?? makeInput();
    const kvRecords = new Map<string, unknown>(opts.saved !== undefined ? [[STATE_KEY, clone(opts.saved)]] : []);
    const persistedStates: unknown[] = [];
    const attemptedStates: unknown[] = [];
    let successfulSets = 0;
    let failedSets = 0;

    const kvSetShouldFail = (): boolean => {
        if (opts.kvSetFails === 'always') return true;
        if (typeof opts.kvSetFails === 'number') return successfulSets >= opts.kvSetFails;
        return false;
    };

    const pages = opts.datasetPages ?? [[
        {
            originalStartUrl: 'https://example.com',
            leadsEnrichment: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
        },
    ]];
    const dataset = {
        getData: vi.fn(async ({ offset }: { offset: number }) => {
            harness.datasetReads += 1;
            return { items: pages[offset] ?? [] };
        }),
    };

    const harness: RuntimeHarness = {
        output: null,
        failures: [],
        kvRecords,
        persistedStates,
        attemptedStates,
        datasetReads: 0,
        run: () => runImport({
            input,
            kv: {
                get: async (key) => clone(kvRecords.get(key)),
                set: async (key, value) => {
                    attemptedStates.push(clone(value));
                    if (kvSetShouldFail()) {
                        failedSets += 1;
                        throw new Error('KV store unavailable');
                    }
                    successfulSets += 1;
                    kvRecords.set(key, clone(value));
                    persistedStates.push(clone(value));
                },
            },
            dataset,
            pushData: async (rows) => {
                published.push(...rows as Record<string, unknown>[]);
            },
            setOutput: async (output) => {
                harness.output = clone(output) as ActorOutput;
            },
            onPersistEvent: () => undefined,
            failRun: async (message) => {
                harness.failures.push(message);
            },
            now: () => new Date('2026-10-14T12:00:00.000Z'),
        }),
    };

    const published: Record<string, unknown>[] = [];
    (harness as unknown as { published: Record<string, unknown>[] }).published = published;
    return harness;
};

const companyRows = (harness: RuntimeHarness) => publishedOf(harness).filter((r) => r.kind === 'company');
const contactRows = (harness: RuntimeHarness) => publishedOf(harness).filter((r) => r.kind === 'contact');
const publishedOf = (harness: RuntimeHarness): Record<string, unknown>[] =>
    (harness as unknown as { published: Record<string, unknown>[] }).published;

const terminalMarker = (harness: RuntimeHarness): Record<string, unknown> => {
    // Read from the last ATTEMPTED state write — a full storage outage never
    // lands the marker, but the run still tried to persist it.
    const list = harness.attemptedStates;
    const attempted = list[list.length - 1] as unknown as { terminal?: Record<string, unknown> } | undefined;
    return attempted?.terminal ?? {};
};

beforeEach(() => {
    apiMocks.searchContactByEmail.mockClear().mockResolvedValue(null);
    apiMocks.searchContactByPhone.mockClear().mockResolvedValue(null);
    apiMocks.createContact.mockClear().mockResolvedValue('contact-new');
    apiMocks.updateContact.mockClear().mockResolvedValue(undefined);
    apiMocks.associateContactToCompany.mockClear().mockResolvedValue(undefined);
});

describe('runImport — checkpoint durability (failed persistence stops CRM work)', () => {
    it('performs ZERO CRM writes when the active-company marker cannot be persisted', async () => {
        const harness = makeRuntime({ kvSetFails: 'always' });

        await harness.run();

        expect(apiMocks.createContact).not.toHaveBeenCalled();
        expect(apiMocks.updateContact).not.toHaveBeenCalled();
        expect(apiMocks.associateContactToCompany).not.toHaveBeenCalled();

        // Evidence + OUTPUT are persisted even though the state store is down.
        expect(companyRows(harness)).toHaveLength(1);
        const row = companyRows(harness)[0];
        expect(row).toMatchObject({
            companyId: 'c1',
            outcome: 'failed',
            resultsComplete: true,
            terminalReason: 'progress_persist_failed',
        });
        expect(String(row.error)).toMatch(/no CRM writes were attempted/i);

        expect(harness.output).toMatchObject({
            resultVersion: RESULT_VERSION_2,
            totalCreated: 0,
            totalFailed: 0,
            resultsComplete: false,
            terminalReason: 'progress_persist_failed',
        });
        expect(harness.failures).toHaveLength(1);
        expect(harness.failures[0]).toMatch(/stopped early \(progress_persist_failed\)/);
        expect(terminalMarker(harness)).toMatchObject({ actorFailed: true });
    });

    it('stops the company (and the run) when a per-contact checkpoint fails after a confirmed write', async () => {
        // Set #1 (active marker) succeeds; every later checkpoint fails.
        const harness = makeRuntime({ kvSetFails: 1 });

        await harness.run();

        // One confirmed create, then the sink failure stops all further writes.
        expect(apiMocks.createContact).toHaveBeenCalledTimes(1);
        expect(contactRows(harness)).toHaveLength(0); // the sink publishes state-first; the row never landed

        const row = companyRows(harness)[0];
        expect(row).toMatchObject({
            status: 'imported',
            outcome: 'partial',
            created: 1,
            resultsComplete: false,
            terminalReason: 'progress_persist_failed',
        });
        expect(String(row.error)).toMatch(/Progress persistence failed/i);

        expect(harness.output).toMatchObject({
            totalCreated: 1,
            resultsComplete: false,
            terminalReason: 'progress_persist_failed',
        });
        expect(harness.failures).toHaveLength(1);
    });
});

describe('runImport — interrupted companies are never replayed and never clean', () => {
    const interruptedState = (stats: { created: number; rowsTotal: number }) => ({
        stateVersion: 2,
        startTime: '2026-10-14T10:00:00.000Z',
        nextCompanyIndex: 0,
        completedCompanies: [],
        active: {
            companyIndex: 0,
            companyId: 'c1',
            companyUrl: 'https://example.com',
            phase: 'processing',
            stats: { created: stats.created, updated: 0, skipped: 0, failed: 0, rowsTotal: stats.rowsTotal },
            lastCompletedLeadIndex: stats.created - 1,
            source: { matchedItems: 1, validLeadRows: stats.rowsTotal, invalidLeadRows: 0, readComplete: true },
        },
    });

    it('publishes retained counts with an explicit error, resultsComplete:false, and never repeats CRM writes', async () => {
        const harness = makeRuntime({
            input: makeInput({
                companies: [
                    { companyId: 'c1', url: 'https://example.com' },
                    { companyId: 'c2', url: 'https://other.com' },
                ],
            }),
            datasetPages: [[
                { originalStartUrl: 'https://example.com', leadsEnrichment: [{ email: 'a@example.com' }, { email: 'b@example.com' }] },
                { originalStartUrl: 'https://other.com', leadsEnrichment: [{ email: 'c@other.com' }] },
            ]],
            saved: interruptedState({ created: 1, rowsTotal: 2 }),
        });

        await harness.run();

        // c1 was interrupted mid-company: its one confirmed create is
        // retained, its remaining lead is NOT attempted (no replay).
        const c1 = companyRows(harness).find((r) => r.companyId === 'c1');
        expect(c1).toMatchObject({
            status: 'imported',
            outcome: 'partial',
            created: 1,
            rowsTotal: 2,
            resultsComplete: false,
            terminalReason: 'interrupted',
        });
        // Legacy-compatible error: a consumer reading only `error` (the
        // backend run finalizer) must see the interruption.
        expect(String(c1!.error)).toMatch(/interrupted/i);

        // Exactly the second company's leads were written — c1 not replayed.
        expect(apiMocks.createContact).toHaveBeenCalledTimes(1);
        expect(apiMocks.createContact).toHaveBeenCalledWith('hs-token', expect.objectContaining({ email: 'c@other.com' }));

        // The interruption is preserved in the run evidence: no full success.
        expect(harness.output).toMatchObject({
            totalCreated: 2,
            resultsComplete: false,
            terminalReason: 'complete',
        });
        expect(harness.failures).toHaveLength(0);
    });

    it('fails the run when an interrupted company retained zero confirmed writes', async () => {
        const harness = makeRuntime({
            saved: interruptedState({ created: 0, rowsTotal: 2 }),
        });

        await harness.run();

        const c1 = companyRows(harness).find((r) => r.companyId === 'c1');
        expect(c1).toMatchObject({ outcome: 'failed', status: 'failed', resultsComplete: false });
        expect(String(c1!.error)).toMatch(/interrupted/i);
        expect(harness.output).toMatchObject({ resultsComplete: false });
        expect(harness.failures).toHaveLength(1);
    });
});

describe('runImport — terminal resurrection preserves the settled Actor status', () => {
    const settledAuthFailure = () => ({
        stateVersion: 2,
        startTime: '2026-10-14T10:00:00.000Z',
        nextCompanyIndex: 1,
        completedCompanies: [{
            kind: 'company',
            resultVersion: 2,
            resultId: 'company:c1:0',
            companyIndex: 0,
            companyId: 'c1',
            companyUrl: 'https://example.com',
            status: 'imported',
            outcome: 'partial',
            created: 1,
            updated: 0,
            skipped: 0,
            failed: 1,
            rowsTotal: 2,
            error: 'Association failed: 401',
            resultsComplete: false,
            terminalReason: 'auth_failed',
            source: { matchedItems: 1, validLeadRows: 2, invalidLeadRows: 0, readComplete: true },
        }],
        terminal: {
            reason: 'auth_failed',
            resultsComplete: false,
            actorFailed: true,
            failureMessage: 'Import stopped early (auth_failed) — confirmed evidence rows were persisted.',
            settledAt: '2026-10-14T11:00:00.000Z',
        },
    });

    it('re-emits OUTPUT, fails the Actor with the preserved message, and touches neither the CRM nor the dataset', async () => {
        const harness = makeRuntime({
            datasetPages: [[{ originalStartUrl: 'https://example.com' }]],
            saved: settledAuthFailure(),
        });

        await harness.run();

        // No dataset read, no CRM call — the settled result is final.
        expect(harness.datasetReads).toBe(0);
        expect(apiMocks.createContact).not.toHaveBeenCalled();

        expect(harness.output).toMatchObject({
            resultVersion: RESULT_VERSION_2,
            totalCreated: 1,
            resultsComplete: false,
            terminalReason: 'auth_failed',
        });
        expect(harness.failures).toHaveLength(1);
        expect(harness.failures[0]).toMatch(/stopped early \(auth_failed\)/);
    });

    it('keeps a previously SUCCEEDED settled run successful', async () => {
        const harness = makeRuntime({
            saved: {
                ...settledAuthFailure(),
                completedCompanies: [{
                    kind: 'company',
                    resultVersion: 2,
                    resultId: 'company:c1:0',
                    companyIndex: 0,
                    companyId: 'c1',
                    companyUrl: 'https://example.com',
                    status: 'imported',
                    outcome: 'complete',
                    created: 2,
                    updated: 0,
                    skipped: 0,
                    failed: 0,
                    rowsTotal: 2,
                    resultsComplete: true,
                    terminalReason: 'complete',
                    source: { matchedItems: 1, validLeadRows: 2, invalidLeadRows: 0, readComplete: true },
                }],
                terminal: { reason: 'complete', resultsComplete: true, actorFailed: false },
            },
        });

        await harness.run();

        expect(harness.output).toMatchObject({ terminalReason: 'complete', resultsComplete: true });
        expect(harness.failures).toHaveLength(0);
        expect(apiMocks.createContact).not.toHaveBeenCalled();
    });

    it('infers failure conservatively for pre-shape terminal markers (no actorFailed field)', async () => {
        const harness = makeRuntime({
            saved: {
                stateVersion: 2,
                startTime: '2026-10-14T10:00:00.000Z',
                nextCompanyIndex: 1,
                completedCompanies: [{
                    kind: 'company',
                    resultVersion: 2,
                    resultId: 'company:c1:0',
                    companyIndex: 0,
                    companyId: 'c1',
                    companyUrl: 'https://example.com',
                    status: 'failed',
                    outcome: 'failed',
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    failed: 2,
                    rowsTotal: 2,
                    error: 'search failed',
                    resultsComplete: true,
                    terminalReason: 'complete',
                    source: { matchedItems: 1, validLeadRows: 2, invalidLeadRows: 0, readComplete: true },
                }],
                terminal: { reason: 'complete', resultsComplete: true },
            },
        });

        await harness.run();

        // Zero writes + failures in the retained rows → the settled run failed.
        expect(harness.failures).toHaveLength(1);
        expect(harness.failures[0]).toMatch(/All lead writes failed/);
    });
});

describe('runImport — per-company evidence for unreadable sources', () => {
    it('surfaces a missing leadsEnrichment field as per-company rows + OUTPUT instead of a global crash', async () => {
        const harness = makeRuntime({
            datasetPages: [[{ originalStartUrl: 'https://example.com' }]], // no leadsEnrichment array
        });

        await harness.run();

        expect(companyRows(harness)).toHaveLength(1);
        expect(companyRows(harness)[0]).toMatchObject({
            companyId: 'c1',
            outcome: 'failed',
            status: 'failed',
            resultsComplete: true,
            terminalReason: 'source_invalid',
        });
        expect(String(companyRows(harness)[0].error)).toMatch(/no leadsEnrichment array/i);

        // OUTPUT persisted BEFORE the run fails (zero writes + real errors).
        // The evidence itself is complete: a deterministic per-company failure.
        expect(harness.output).toMatchObject({
            totalCreated: 0,
            resultsComplete: true,
            terminalReason: 'complete',
        });
        expect(harness.failures).toHaveLength(1);
        expect(harness.failures[0]).toMatch(/All lead writes failed/);
    });

    it('treats an explicit empty leadsEnrichment array as a successful no-results run', async () => {
        const harness = makeRuntime({
            datasetPages: [[{ originalStartUrl: 'https://example.com', leadsEnrichment: [] }]],
        });

        await harness.run();

        expect(companyRows(harness)[0]).toMatchObject({
            outcome: 'no_results',
            status: 'imported',
            resultsComplete: true,
            terminalReason: 'no_results',
        });
        expect(harness.output).toMatchObject({ totalCreated: 0, resultsComplete: true });
        expect(harness.failures).toHaveLength(0);
    });
});

describe('runImport — legacy (v1) resumed rows stay legacy', () => {
    it('preserves a real v1 row, keeps totals finite, marks evidence incomplete, and does not replay it', async () => {
        const harness = makeRuntime({
            input: makeInput({
                companies: [
                    { companyId: 'c1', url: 'https://example.com' },
                    { companyId: 'c2', url: 'https://other.com' },
                ],
            }),
            datasetPages: [[
                { originalStartUrl: 'https://example.com', leadsEnrichment: [{ email: 'a@example.com' }] },
                { originalStartUrl: 'https://other.com', leadsEnrichment: [{ email: 'c@other.com' }] },
            ]],
            saved: {
                // A REAL v1 record: no resultVersion, no failed/resultsComplete.
                results: [{
                    kind: 'company',
                    companyId: 'c1',
                    companyUrl: 'https://example.com',
                    status: 'imported',
                    created: 1,
                    updated: 0,
                    skipped: 2, // v1: may include failed writes
                    rowsTotal: 3,
                }],
                processedIndex: 1,
            },
        });

        await harness.run();

        // c1 (legacy, already published) is NOT replayed — only c2 runs.
        expect(apiMocks.createContact).toHaveBeenCalledTimes(1);
        expect(apiMocks.createContact).toHaveBeenCalledWith('hs-token', expect.objectContaining({ email: 'c@other.com' }));
        expect(companyRows(harness)).toHaveLength(1); // only c2's fresh row
        expect(companyRows(harness)[0].companyId).toBe('c2');

        const output = harness.output!;
        // Finite totals — never NaN (which would serialize as null).
        expect(output.totalCreated).toBe(2); // legacy 1 + fresh 1
        expect(output.totalSkipped).toBe(2); // legacy carried through
        expect(output.totalFailed).toBe(0);
        expect(output.terminalReason).toBe('complete');
        // The unknowable legacy failed/skipped split stays explicit.
        expect(output.legacyResultRows).toBe(1);
        expect(output.resultsComplete).toBe(false);

        // The legacy row keeps its legacy identity in OUTPUT.results.
        const legacy = output.results[0] as unknown as Record<string, unknown>;
        expect(legacy.companyId).toBe('c1');
        expect(legacy.resultVersion).toBeUndefined();
        expect(legacy.skipped).toBe(2);
        expect(legacy.resultsComplete).toBeUndefined();
        expect(legacy.terminalReason).toBeUndefined();
    });

    it('fails the run when a resumed legacy run is the whole evidence and it carries only errors', async () => {
        const harness = makeRuntime({
            input: makeInput({
                companies: [{ companyId: 'c1', url: 'https://example.com' }],
            }),
            datasetPages: [[{ someOtherField: true }]], // non-empty, but nothing maps
            saved: {
                results: [{
                    kind: 'company',
                    companyId: 'c1',
                    companyUrl: 'https://example.com',
                    status: 'failed',
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    rowsTotal: 1,
                    error: 'search failed',
                }],
                processedIndex: 1,
            },
        });

        await harness.run();

        // Zero writes + a company error → the run fails (with evidence kept).
        expect(harness.failures).toHaveLength(1);
        expect(harness.failures[0]).toMatch(/All lead writes failed/);
        expect(harness.output!.resultsComplete).toBe(false);
    });
});

describe('computeRunTotals — mixed generations', () => {
    it('keeps legacy failed/skipped ambiguity out of totalFailed', () => {
        const totals = computeRunTotals([
            {
                kind: 'company',
                companyId: 'legacy',
                companyUrl: 'x',
                status: 'imported',
                created: 1,
                updated: 0,
                skipped: 3,
                rowsTotal: 4,
            },
            {
                kind: 'company',
                resultVersion: 2,
                resultId: 'company:modern:1',
                companyIndex: 1,
                companyId: 'modern',
                companyUrl: 'y',
                status: 'imported',
                outcome: 'partial',
                created: 1,
                updated: 0,
                skipped: 0,
                failed: 2,
                rowsTotal: 3,
                resultsComplete: true,
                terminalReason: 'complete',
                source: { matchedItems: 1, validLeadRows: 3, invalidLeadRows: 0, readComplete: true },
            },
        ]);

        expect(totals).toMatchObject({
            totalCreated: 2,
            totalSkipped: 3,
            totalFailed: 2, // only the v2 row's known failures
            legacyResultRows: 1,
            anyCompanyHadError: true,
            zeroWrites: false,
        });
    });
});