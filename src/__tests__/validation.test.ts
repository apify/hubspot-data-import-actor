import { describe, it, expect } from 'vitest';
import { validateInput } from '../validation.js';

const validInput = {
    hubspotAccessToken: 'pat-na1-abc123',
    datasetId: 'abc123',
    importMode: 'contacts' as const,
    companyUrlMapping: [{ url: 'https://example.com', companyId: '123' }],
    dataMappings: [{ source: 'email', target: 'email' }],
};

describe('validateInput', () => {
    it('accepts valid input', () => {
        const result = validateInput(validInput);
        expect(result.hubspotAccessToken).toBe('pat-na1-abc123');
        expect(result.datasetId).toBe('abc123');
        expect(result.importMode).toBe('contacts');
    });

    it('rejects missing hubspotAccessToken', () => {
        expect(() => validateInput({ ...validInput, hubspotAccessToken: '' })).toThrow();
    });

    it('rejects missing datasetId', () => {
        expect(() => validateInput({ ...validInput, datasetId: '' })).toThrow();
    });

    it('rejects importMode other than "contacts"', () => {
        expect(() => validateInput({ ...validInput, importMode: 'company' })).toThrow();
    });

    it('rejects empty companyUrlMapping', () => {
        expect(() => validateInput({ ...validInput, companyUrlMapping: [] })).toThrow();
    });

    it('rejects empty dataMappings', () => {
        expect(() => validateInput({ ...validInput, dataMappings: [] })).toThrow();
    });

    it('rejects dataMappings with empty source', () => {
        expect(() => validateInput({ ...validInput, dataMappings: [{ source: '', target: 'x' }] })).toThrow();
    });

    it('rejects dataMappings with empty target', () => {
        expect(() => validateInput({ ...validInput, dataMappings: [{ source: 'email', target: '' }] })).toThrow();
    });

    it('accepts dataMappings with any source (no longer whitelisted)', () => {
        expect(() =>
            validateInput({ ...validInput, dataMappings: [{ source: 'revenue', target: 'annualrevenue' }] }),
        ).not.toThrow();
    });

    it('accepts dot-path sources', () => {
        expect(() =>
            validateInput({ ...validInput, dataMappings: [{ source: 'meta.industry', target: 'industry' }] }),
        ).not.toThrow();
    });

    it('allows companyUrlMapping without url (optional)', () => {
        const input = { ...validInput, companyUrlMapping: [{ companyId: '123' }] };
        const result = validateInput(input);
        expect(result.companyUrlMapping[0].companyId).toBe('123');
    });

    it('trims whitespace from string fields', () => {
        const input = {
            ...validInput,
            hubspotAccessToken: '  token  ',
            datasetId: '  ds123  ',
        };
        const result = validateInput(input);
        expect(result.hubspotAccessToken).toBe('token');
        expect(result.datasetId).toBe('ds123');
    });
});
