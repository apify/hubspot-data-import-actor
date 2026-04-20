import { describe, it, expect } from 'vitest';
import { validateInput, LeadsEnrichmentRowSchema, LEADS_ENRICHMENT_FIELD_KEYS } from '../validation.js';

const validInput = {
    hubspotAccessToken: 'pat-na1-abc123',
    datasetId: 'abc123',
    importMode: 'contacts' as const,
    runId: 'run-1',
    runSecret: 'secret-1',
    callbackUrl: 'https://backend.example.com/hubspot/config/runs/import-callback',
    companyUrlMapping: [{ url: 'https://example.com', companyId: '123' }],
    dataMappings: [{ source: 'email', target: 'email' }],
};

describe('validateInput', () => {
    it('accepts valid input', () => {
        const result = validateInput(validInput);
        expect(result.hubspotAccessToken).toBe('pat-na1-abc123');
        expect(result.datasetId).toBe('abc123');
        expect(result.importMode).toBe('contacts');
        expect(result.runId).toBe('run-1');
        expect(result.runSecret).toBe('secret-1');
        expect(result.callbackUrl).toBe('https://backend.example.com/hubspot/config/runs/import-callback');
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

    it('rejects missing runId', () => {
        expect(() => validateInput({ ...validInput, runId: '' })).toThrow();
    });

    it('rejects missing runSecret', () => {
        expect(() => validateInput({ ...validInput, runSecret: '' })).toThrow();
    });

    it('rejects invalid callbackUrl', () => {
        expect(() => validateInput({ ...validInput, callbackUrl: 'not-a-url' })).toThrow();
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

    it('rejects dataMappings with source not in LEADS_ENRICHMENT_FIELD_KEYS', () => {
        expect(() =>
            validateInput({ ...validInput, dataMappings: [{ source: 'revenue', target: 'annualrevenue' }] }),
        ).toThrow(/is not a valid leadsEnrichment field/);
    });

    it('accepts every LEADS_ENRICHMENT_FIELD_KEYS value as a source', () => {
        const mappings = LEADS_ENRICHMENT_FIELD_KEYS.map((k) => ({ source: k, target: `hs_${k}` }));
        const result = validateInput({ ...validInput, dataMappings: mappings });
        expect(result.dataMappings).toHaveLength(LEADS_ENRICHMENT_FIELD_KEYS.length);
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
