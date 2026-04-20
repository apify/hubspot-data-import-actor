import { describe, it, expect } from 'vitest';
import { validateInput, LeadsEnrichmentRowSchema, LEADS_ENRICHMENT_FIELD_KEYS } from '../validation.js';

const validInput = {
    hubspotAccessToken: 'pat-na1-abc123',
    datasetId: 'abc123',
    companyUrlMapping: [{ url: 'https://example.com', companyId: '123' }],
    dataMappings: [{ source: 'revenue', target: 'annualrevenue' }],
};

describe('validateInput', () => {
    it('accepts valid input', () => {
        const result = validateInput(validInput);
        expect(result.hubspotAccessToken).toBe('pat-na1-abc123');
        expect(result.datasetId).toBe('abc123');
    });

    it('rejects missing hubspotAccessToken', () => {
        expect(() => validateInput({ ...validInput, hubspotAccessToken: '' })).toThrow();
    });

    it('rejects missing datasetId', () => {
        expect(() => validateInput({ ...validInput, datasetId: '' })).toThrow();
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
        expect(() => validateInput({ ...validInput, dataMappings: [{ source: 'x', target: '' }] })).toThrow();
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

describe('LeadsEnrichmentRowSchema', () => {
    it('accepts a fully populated row', () => {
        const row = {
            personId: 'p1', firstName: 'Jane', lastName: 'Doe',
            fullName: 'Jane Doe', linkedinProfile: 'https://linkedin.com/in/janedoe',
            email: 'jane@example.com', mobileNumber: '+1234567890',
            jobTitle: 'Engineer', industry: 'Tech', city: 'NYC',
            state: 'NY', country: 'US', companyId: 'c1',
            companyName: 'Acme', companyWebsite: 'acme.com',
            companySize: '50-100', companyLinkedin: 'https://linkedin.com/company/acme',
            companyCity: 'NYC', companyState: 'NY', companyCountry: 'US',
            companyPhoneNumber: '+1234567890', headline: 'Software Engineer',
            departments: ['Engineering'], seniority: 'Senior',
            photoUrl: 'https://example.com/photo.jpg', twitter: '@janedoe',
        };
        expect(() => LeadsEnrichmentRowSchema.parse(row)).not.toThrow();
    });

    it('accepts a row with all null fields', () => {
        const row = Object.fromEntries(
            LEADS_ENRICHMENT_FIELD_KEYS.map((k) => [k, null]),
        );
        expect(() => LeadsEnrichmentRowSchema.parse(row)).not.toThrow();
    });

    it('accepts an empty row (all fields optional)', () => {
        expect(() => LeadsEnrichmentRowSchema.parse({})).not.toThrow();
    });

    it('covers all expected field keys', () => {
        const expectedFields = [
            'personId', 'firstName', 'lastName', 'fullName', 'linkedinProfile',
            'email', 'mobileNumber', 'jobTitle', 'industry', 'city', 'state',
            'country', 'companyId', 'companyName', 'companyWebsite', 'companySize',
            'companyLinkedin', 'companyCity', 'companyState', 'companyCountry',
            'companyPhoneNumber', 'headline', 'departments', 'seniority',
            'photoUrl', 'twitter',
        ];
        expect([...LEADS_ENRICHMENT_FIELD_KEYS]).toEqual(expectedFields);
    });
});
