import { describe, it, expect } from 'vitest';
import type { CompanyUrlMapping, ContactImportStats, LeadsEnrichmentRow } from '../types.js';
import {
    assertDatasetHasLeads,
    assertSomeCompaniesMatch,
    assertSomeWritesSucceeded,
    deriveCompanyStatus,
} from '../failStates.js';

describe('assertDatasetHasLeads', () => {
    it('throws when all dataset items have empty leadsEnrichment arrays', () => {
        const leadsByUrl = new Map<string, LeadsEnrichmentRow[]>([
            ['example.com', []],
            ['foo.com', []],
        ]);
        expect(() => assertDatasetHasLeads('ds1', 2, leadsByUrl)).toThrow(/no leadsEnrichment rows/);
    });

    it('throws when the map is empty', () => {
        expect(() => assertDatasetHasLeads('ds1', 3, new Map())).toThrow(/no leadsEnrichment rows/);
    });

    it('does not throw when at least one URL has leads', () => {
        const leadsByUrl = new Map<string, LeadsEnrichmentRow[]>([
            ['example.com', []],
            ['foo.com', [{ email: 'a@b.com' }]],
        ]);
        expect(() => assertDatasetHasLeads('ds1', 2, leadsByUrl)).not.toThrow();
    });
});

describe('assertSomeCompaniesMatch', () => {
    const leadsByUrl = new Map<string, LeadsEnrichmentRow[]>([
        ['example.com', [{ email: 'a@b.com' }]],
    ]);

    it('throws when no company URL matches any dataset URL', () => {
        const mapping: CompanyUrlMapping[] = [
            { url: 'https://other.com', companyId: 'c1' },
            { url: 'https://nope.com', companyId: 'c2' },
        ];
        expect(() => assertSomeCompaniesMatch(mapping, leadsByUrl)).toThrow(/None of the 2/);
    });

    it('throws when all company URLs are empty/undefined', () => {
        const mapping: CompanyUrlMapping[] = [
            { url: '', companyId: 'c1' },
            { companyId: 'c2' },
        ];
        expect(() => assertSomeCompaniesMatch(mapping, leadsByUrl)).toThrow(/None of the 2/);
    });

    it('does not throw when at least one URL matches (normalized)', () => {
        const mapping: CompanyUrlMapping[] = [
            { url: 'https://www.EXAMPLE.com/', companyId: 'c1' },
            { url: 'https://nope.com', companyId: 'c2' },
        ];
        expect(() => assertSomeCompaniesMatch(mapping, leadsByUrl)).not.toThrow();
    });
});

describe('assertSomeWritesSucceeded', () => {
    it('throws when nothing was written and at least one company had an error', () => {
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 0, anyCompanyHadError: true,
        })).toThrow(/All lead writes failed/);
    });

    it('does not throw when at least one write succeeded', () => {
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 1, totalUpdated: 0, anyCompanyHadError: true,
        })).not.toThrow();
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 1, anyCompanyHadError: true,
        })).not.toThrow();
    });

    it('does not throw when zero writes but no errors (e.g. every row had no email)', () => {
        expect(() => assertSomeWritesSucceeded({
            totalCreated: 0, totalUpdated: 0, anyCompanyHadError: false,
        })).not.toThrow();
    });
});

describe('deriveCompanyStatus', () => {
    const base = (over: Partial<ContactImportStats> = {}): ContactImportStats => ({
        created: 0, updated: 0, skipped: 0, rowsTotal: 0, ...over,
    });

    it('returns "failed" when every row errored and nothing was written', () => {
        expect(deriveCompanyStatus(base({ rowsTotal: 2, skipped: 2, error: 'boom' }))).toBe('failed');
    });

    it('returns "imported" when some writes succeeded, even with errors', () => {
        expect(deriveCompanyStatus(base({ rowsTotal: 2, created: 1, skipped: 1, error: 'boom' }))).toBe('imported');
        expect(deriveCompanyStatus(base({ rowsTotal: 2, updated: 1, skipped: 1, error: 'boom' }))).toBe('imported');
    });

    it('returns "imported" when rowsTotal is 0 (nothing to do is not a failure)', () => {
        expect(deriveCompanyStatus(base({ rowsTotal: 0 }))).toBe('imported');
    });

    it('returns "imported" when there is no error even if no writes happened', () => {
        // e.g. every row had no email — skipped but not an error
        expect(deriveCompanyStatus(base({ rowsTotal: 2, skipped: 2 }))).toBe('imported');
    });
});
