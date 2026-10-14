import { describe, it, expect } from 'vitest';
import {
    classifyCompanySource,
    companyVerificationEvidenceMissing,
    readSourceDataset,
    type SourceDatasetLike,
} from '../source-results.js';

const pageOf = (pages: Record<string, unknown>[][]): SourceDatasetLike => {
    let call = 0;
    return {
        getData: async () => {
            const items = pages[call] ?? [];
            call += 1;
            return { items };
        },
    };
};

describe('readSourceDataset', () => {
    it('groups evidence per normalized URL and counts valid/malformed rows', async () => {
        const dataset = pageOf([
            [
                {
                    originalStartUrl: 'https://www.Example.com/',
                    leadsEnrichment: [{ email: 'a@b.com' }, { email: 'not-an-object', firstName: 12345 }],
                },
                { originalStartUrl: 'https://example.com', leadsEnrichment: [{ email: 'c@d.com' }] },
                { originalStartUrl: 'https://empty.com', leadsEnrichment: [] },
                { someOtherField: true }, // no originalStartUrl — counted, not mapped
            ],
            [], // terminal empty page
        ]);

        const evidence = await readSourceDataset(dataset, 'ds1');

        expect(evidence.readComplete).toBe(true);
        expect(evidence.totalItems).toBe(4);
        expect(evidence.byUrl.get('example.com')).toMatchObject({
            matchedItems: 2,
            leadsEnrichmentPresent: true,
            validLeadRows: [expect.objectContaining({ email: 'a@b.com' }), expect.objectContaining({ email: 'c@d.com' })],
            invalidLeadRows: 1,
        });
        expect(evidence.byUrl.get('empty.com')).toMatchObject({
            leadsEnrichmentPresent: true,
            validLeadRows: [],
            invalidLeadRows: 0,
        });
    });

    it('marks the read incomplete with the error when getData fails', async () => {
        const dataset: SourceDatasetLike = {
            getData: async () => { throw new Error('connection reset'); },
        };
        const evidence = await readSourceDataset(dataset, 'ds1');
        expect(evidence.readComplete).toBe(false);
        expect(evidence.readError).toContain('connection reset');
        expect(evidence.totalItems).toBe(0);
    });
});

describe('classifyCompanySource', () => {
    const byUrl = new Map([
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
        ['broken.com', {
            matchedItems: 1,
            leadsEnrichmentPresent: true,
            validLeadRows: [],
            invalidLeadRows: 3,
        }],
        ['nofield.com', {
            matchedItems: 1,
            leadsEnrichmentPresent: false,
            validLeadRows: [],
            invalidLeadRows: 0,
        }],
    ]);

    it('classifies a missing URL as no_company_url', () => {
        expect(classifyCompanySource(undefined, byUrl)).toMatchObject({
            kind: 'invalid_source', reasonCode: 'no_company_url',
        });
        expect(classifyCompanySource('   ', byUrl)).toMatchObject({
            kind: 'invalid_source', reasonCode: 'no_company_url',
        });
    });

    it('classifies an unmatched URL as unmatched_company (normalized comparison)', () => {
        expect(classifyCompanySource('https://www.NoMatch.com/', byUrl)).toMatchObject({
            kind: 'invalid_source', reasonCode: 'unmatched_company',
        });
    });

    it('classifies a missing leads field as source_invalid', () => {
        expect(classifyCompanySource('https://nofield.com', byUrl)).toMatchObject({
            kind: 'invalid_source', reasonCode: 'source_invalid',
        });
    });

    it('classifies all-malformed rows as source_invalid', () => {
        expect(classifyCompanySource('https://broken.com', byUrl)).toMatchObject({
            kind: 'invalid_source', reasonCode: 'source_invalid',
        });
    });

    it('classifies an explicit empty leads array as valid_empty (success, not error)', () => {
        expect(classifyCompanySource('https://www.EMPTY.com/', byUrl)).toMatchObject({
            kind: 'valid_empty',
        });
    });

    it('classifies present valid rows as valid_leads', () => {
        expect(classifyCompanySource('https://example.com', byUrl)).toMatchObject({
            kind: 'valid_leads',
        });
    });
});

describe('companyVerificationEvidenceMissing', () => {
    it('is missing when an email-bearing lead has no verification block anywhere', () => {
        expect(companyVerificationEvidenceMissing([{ email: 'a@b.com' }])).toBe(true);
    });

    it('is present when any lead carries a verification block', () => {
        expect(companyVerificationEvidenceMissing([
            { email: 'a@b.com', emailVerification: { result: 'invalid' } },
        ])).toBe(false);
    });

    it('is NOT missing when no lead carries an email (intentional skips either way)', () => {
        expect(companyVerificationEvidenceMissing([{ firstName: 'No' }])).toBe(false);
    });
});