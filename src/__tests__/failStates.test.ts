import { describe, it, expect } from 'vitest';
import type { ContactImportStats } from '../types.js';
import type { SourceDatasetEvidence } from '../source-results.js';
import {
    assertDatasetUsable,
    assertSomeWritesSucceeded,
    companySourceEvidence,
    deriveCompanyOutcome,
} from '../failStates.js';

const datasetEvidence = (
    overrides: Partial<SourceDatasetEvidence> = {},
): SourceDatasetEvidence => ({
    datasetId: 'ds1',
    totalItems: 2,
    readComplete: true,
    byUrl: new Map([
        ['example.com', {
            matchedItems: 1,
            leadsEnrichmentPresent: true,
            validLeadRows: [{ email: 'a@b.com' }],
            invalidLeadRows: 0,
        }],
        ['empty.com', {
            matchedItems: 1,
            leadsEnrichmentPresent: true,
            validLeadRows: [],
            invalidLeadRows: 0,
        }],
    ]),
    ...overrides,
}) as SourceDatasetEvidence;

describe('assertDatasetUsable', () => {
    it('throws when the dataset read failed (an unreadable dataset proves nothing)', () => {
        expect(() => assertDatasetUsable('ds1', datasetEvidence({
            readComplete: false,
            readError: 'connection reset',
        }))).toThrow(/Failed reading dataset/);
    });

    it('throws when the dataset is empty (not proof of a valid empty enrichment)', () => {
        expect(() => assertDatasetUsable('ds1', datasetEvidence({
            totalItems: 0,
            byUrl: new Map(),
        }))).toThrow(/is empty/);
    });

    it('accepts a dataset whose items carry NO leadsEnrichment arrays (per-company classification handles it)', () => {
        // A readable, non-empty dataset with no leads field anywhere is NOT a
        // run-level crash: every matched company classifies `source_invalid`
        // and surfaces as a deterministic per-company failure row.
        const evidence = datasetEvidence();
        for (const per of evidence.byUrl.values()) per.leadsEnrichmentPresent = false;
        expect(() => assertDatasetUsable('ds1', evidence)).not.toThrow();
    });

    it('accepts a dataset with at least one leads field (explicit empty arrays are fine)', () => {
        expect(() => assertDatasetUsable('ds1', datasetEvidence())).not.toThrow();
    });
});

describe('deriveCompanyOutcome', () => {
    const stats = (over: Partial<ContactImportStats> = {}): ContactImportStats => ({
        created: 0, updated: 0, skipped: 0, failed: 0, rowsTotal: 2, ...over,
    });

    it('classifies a deterministic invalid source as a complete failure with legacy statuses', () => {
        const noUrl = deriveCompanyOutcome({ stats: stats(), processingComplete: true, sourceValid: false, noCompanyUrl: true });
        expect(noUrl).toMatchObject({ outcome: 'failed', status: 'skipped', resultsComplete: true });

        const unmatched = deriveCompanyOutcome({ stats: stats(), processingComplete: true, sourceValid: false, noCompanyUrl: false });
        expect(unmatched).toMatchObject({ outcome: 'failed', status: 'failed', resultsComplete: true });
    });

    it('classifies an incomplete company by its confirmed writes (never "zero writes")', () => {
        const withWrites = deriveCompanyOutcome({
            stats: stats({ created: 2, failed: 1 }),
            processingComplete: false,
            sourceValid: true,
        });
        expect(withWrites).toMatchObject({
            outcome: 'partial', status: 'imported', resultsComplete: false, terminalReason: 'interrupted',
        });

        const noWrites = deriveCompanyOutcome({
            stats: stats({ created: 0 }),
            processingComplete: false,
            sourceValid: true,
        });
        expect(noWrites).toMatchObject({
            outcome: 'failed', status: 'failed', resultsComplete: false,
        });
    });

    it('classifies zero valid lead rows as valid no_results', () => {
        const derived = deriveCompanyOutcome({
            stats: stats({ rowsTotal: 0 }),
            processingComplete: true,
            sourceValid: true,
        });
        expect(derived).toMatchObject({
            outcome: 'no_results', status: 'imported', resultsComplete: true, terminalReason: 'no_results',
        });
    });

    it('classifies an all-intentional-skip company as complete with a no-change reason', () => {
        const derived = deriveCompanyOutcome({
            stats: stats({ skipped: 2 }),
            processingComplete: true,
            sourceValid: true,
        });
        expect(derived).toMatchObject({
            outcome: 'complete', status: 'imported', resultsComplete: true, terminalReason: 'no_change',
        });
    });

    it('classifies writes plus failures as partial, and failures without writes as failed', () => {
        expect(deriveCompanyOutcome({
            stats: stats({ created: 1, failed: 1 }),
            processingComplete: true,
            sourceValid: true,
        })).toMatchObject({ outcome: 'partial', status: 'imported', resultsComplete: true });

        expect(deriveCompanyOutcome({
            stats: stats({ failed: 2, error: 'boom' }),
            processingComplete: true,
            sourceValid: true,
        })).toMatchObject({ outcome: 'failed', status: 'failed', resultsComplete: true });
    });

    it('classifies clean writes without errors as complete', () => {
        expect(deriveCompanyOutcome({
            stats: stats({ created: 2, updated: 1 }),
            processingComplete: true,
            sourceValid: true,
        })).toMatchObject({ outcome: 'complete', status: 'imported', resultsComplete: true });
    });
});

describe('companySourceEvidence', () => {
    it('converts full evidence into row-level counts and tolerates null', () => {
        expect(companySourceEvidence({
            matchedItems: 2,
            leadsEnrichmentPresent: true,
            validLeadRows: [{ email: 'a@b.com' }, { email: 'c@d.com' }],
            invalidLeadRows: 1,
        })).toEqual({ matchedItems: 2, validLeadRows: 2, invalidLeadRows: 1, readComplete: true });

        expect(companySourceEvidence(null)).toEqual({
            matchedItems: 0, validLeadRows: 0, invalidLeadRows: 0, readComplete: true,
        });
    });
});

describe('assertSomeWritesSucceeded', () => {
    it('throws when nothing was written and contacts failed or companies errored', () => {
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 0, totalFailed: 3, anyCompanyHadError: false,
        })).toThrow(/All lead writes failed/);

        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 0, totalFailed: 0, anyCompanyHadError: true,
        })).toThrow(/All lead writes failed/);
    });

    it('does not throw when at least one write succeeded', () => {
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 1, totalUpdated: 0, totalFailed: 2, anyCompanyHadError: true,
        })).not.toThrow();
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 1, totalFailed: 0, anyCompanyHadError: true,
        })).not.toThrow();
    });

    it('does not throw when zero writes but no failures (all-skip or valid no-results)', () => {
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 0, totalFailed: 0, anyCompanyHadError: false,
        })).not.toThrow();
    });
});