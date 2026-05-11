import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { processCompanyLeads } from '../contacts.js';
import { HubspotApiError, HubspotAuthError } from '../api.js';
import type { DataMapping, LeadsEnrichmentRow } from '../types.js';
import * as api from '../api.js';

const DEFAULT_MAPPINGS: DataMapping[] = [
    { source: 'email', target: 'email', overwriteMode: 'overwrite' },
    { source: 'firstName', target: 'firstname', overwriteMode: 'overwrite' },
    { source: 'lastName', target: 'lastname', overwriteMode: 'overwrite' },
    { source: 'jobTitle', target: 'jobtitle', overwriteMode: 'overwrite' },
    { source: 'mobileNumber', target: 'phone', overwriteMode: 'overwrite' },
];

let searchByEmail: ReturnType<typeof vi.spyOn>;
let searchByPhone: ReturnType<typeof vi.spyOn>;
let create: ReturnType<typeof vi.spyOn>;
let update: ReturnType<typeof vi.spyOn>;
let associate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    searchByEmail = vi.spyOn(api, 'searchContactByEmail').mockResolvedValue(null);
    searchByPhone = vi.spyOn(api, 'searchContactByPhone').mockResolvedValue(null);
    create = vi.spyOn(api, 'createContact').mockResolvedValue('c-new');
    update = vi.spyOn(api, 'updateContact').mockResolvedValue(undefined);
    associate = vi.spyOn(api, 'associateContactToCompany').mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('processCompanyLeads', () => {
    it('skips leads without an email and does not call HubSpot', async () => {
        const leads: LeadsEnrichmentRow[] = [{ firstName: 'No', lastName: 'Email' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email');
        expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, rowsTotal: 1 });
        expect(searchByEmail).not.toHaveBeenCalled();
    });

    it('creates a contact when search returns no match, then associates it', async () => {
        searchByEmail.mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('contact-new');
        const leads: LeadsEnrichmentRow[] = [
            { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' },
        ];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email');
        expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, rowsTotal: 1 });
        expect(create).toHaveBeenCalledWith('tok', { email: 'jane@example.com', firstname: 'Jane', lastname: 'Doe' });
        expect(associate).toHaveBeenCalledWith('tok', 'contact-new', 'c1');
    });

    it('updates an existing contact when search finds a match', async () => {
        searchByEmail.mockResolvedValueOnce({ id: 'contact-123', properties: {} });
        const leads: LeadsEnrichmentRow[] = [
            { email: 'jane@example.com', firstName: 'Jane', mobileNumber: '+1' },
        ];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email');
        expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, rowsTotal: 1 });
        expect(update).toHaveBeenCalledWith('tok', 'contact-123', {
            email: 'jane@example.com', firstname: 'Jane', phone: '+1',
        });
        expect(associate).toHaveBeenCalledWith('tok', 'contact-123', 'c1');
    });

    it('captures first error when association fails with non-auth error', async () => {
        searchByEmail.mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('c-new');
        associate.mockRejectedValueOnce(new HubspotApiError(500, 'boom', '/assoc'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email');
        expect(stats.created).toBe(1);
        expect(stats.skipped).toBe(0);
        expect(stats.error).toContain('500');
    });

    it('counts row as skipped and captures error when search fails', async () => {
        searchByEmail.mockRejectedValueOnce(new HubspotApiError(500, 'server down', '/search'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email');
        expect(stats).toMatchObject({ created: 0, updated: 0, skipped: 1, rowsTotal: 1 });
        expect(stats.error).toContain('500');
    });

    it('propagates HubspotAuthError from search (does not count as skipped)', async () => {
        searchByEmail.mockRejectedValueOnce(new HubspotAuthError('/search', 'invalid token'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        await expect(processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email'))
            .rejects.toBeInstanceOf(HubspotAuthError);
    });

    it('propagates HubspotAuthError from association', async () => {
        searchByEmail.mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('c-new');
        associate.mockRejectedValueOnce(new HubspotAuthError('/assoc', 'invalid token'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        await expect(processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email'))
            .rejects.toBeInstanceOf(HubspotAuthError);
    });

    it('processes a mix of skip/create/update rows', async () => {
        searchByEmail
            .mockResolvedValueOnce({ id: 'c-1', properties: {} })
            .mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('c-3');
        const leads: LeadsEnrichmentRow[] = [
            { email: 'a@b.com', firstName: 'A' },
            { firstName: 'NoEmail' },
            { email: 'c@d.com', firstName: 'C' },
        ];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'email');
        expect(stats).toEqual({ created: 1, updated: 1, skipped: 1, rowsTotal: 3 });
    });

    describe('per-mapping overwrite/skip', () => {
        it('omits a skipped field when the existing contact has a non-empty value for it', async () => {
            const mappings: DataMapping[] = [
                { source: 'email', target: 'email', overwriteMode: 'overwrite' },
                { source: 'firstName', target: 'firstname', overwriteMode: 'overwrite' },
                { source: 'jobTitle', target: 'jobtitle', overwriteMode: 'skip' },
            ];
            searchByEmail.mockResolvedValueOnce({
                id: 'c-123',
                properties: { email: 'a@b.com', jobtitle: 'Existing Title' },
            });
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'Jane', jobTitle: 'New Title' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, mappings, 'email');
            expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, rowsTotal: 1 });
            expect(searchByEmail).toHaveBeenCalledWith('tok', 'a@b.com', ['jobtitle']);
            expect(update).toHaveBeenCalledWith('tok', 'c-123', { email: 'a@b.com', firstname: 'Jane' });
        });

        it('overwrites a skipped field when the existing contact is empty for it', async () => {
            const mappings: DataMapping[] = [
                { source: 'email', target: 'email', overwriteMode: 'overwrite' },
                { source: 'jobTitle', target: 'jobtitle', overwriteMode: 'skip' },
            ];
            searchByEmail.mockResolvedValueOnce({
                id: 'c-123',
                properties: { email: 'a@b.com', jobtitle: '' },
            });
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', jobTitle: 'New Title' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, mappings, 'email');
            expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, rowsTotal: 1 });
        });

        it('still creates a new contact with all fields when no match is found, regardless of skip flags', async () => {
            const mappings: DataMapping[] = [
                { source: 'email', target: 'email', overwriteMode: 'overwrite' },
                { source: 'jobTitle', target: 'jobtitle', overwriteMode: 'skip' },
            ];
            searchByEmail.mockResolvedValueOnce(null);
            create.mockResolvedValueOnce('c-new');
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', jobTitle: 'New Title' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, mappings, 'email');
            expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, rowsTotal: 1 });
            expect(create).toHaveBeenCalledWith('tok', { email: 'a@b.com', jobtitle: 'New Title' });
        });

        it('counts row as skipped and makes no update call when every field is preserved', async () => {
            const mappings: DataMapping[] = [
                { source: 'email', target: 'email', overwriteMode: 'skip' },
                { source: 'firstName', target: 'firstname', overwriteMode: 'skip' },
            ];
            searchByEmail.mockResolvedValueOnce({
                id: 'c-123',
                properties: { email: 'a@b.com', firstname: 'Existing' },
            });
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'Jane' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, mappings, 'email');
            expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, rowsTotal: 1 });
            expect(update).not.toHaveBeenCalled();
            expect(associate).toHaveBeenCalledWith('tok', 'c-123', 'c1');
        });
    });

    describe('phone deduplication', () => {
        it('skips leads without a mobileNumber when dedup is phone', async () => {
            const leads: LeadsEnrichmentRow[] = [
                { email: 'has@email.com', firstName: 'NoPhone' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'phone');
            expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, rowsTotal: 1 });
            expect(searchByPhone).not.toHaveBeenCalled();
        });

        it('searches by phone and creates when no match', async () => {
            searchByPhone.mockResolvedValueOnce(null);
            create.mockResolvedValueOnce('c-phone-new');
            const leads: LeadsEnrichmentRow[] = [
                { mobileNumber: '+15551234567', firstName: 'Jane' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'phone');
            expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, rowsTotal: 1 });
            expect(searchByPhone).toHaveBeenCalledWith('tok', '+15551234567', []);
            expect(create).toHaveBeenCalledWith('tok', { phone: '+15551234567', firstname: 'Jane' });
            expect(associate).toHaveBeenCalledWith('tok', 'c-phone-new', 'c1');
        });

        it('searches by phone and updates on match', async () => {
            searchByPhone.mockResolvedValueOnce({ id: 'c-phone-existing', properties: {} });
            const leads: LeadsEnrichmentRow[] = [
                { mobileNumber: '+15551234567', firstName: 'Jane' },
            ];
            const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS, 'phone');
            expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, rowsTotal: 1 });
            expect(update).toHaveBeenCalledWith('tok', 'c-phone-existing', expect.any(Object));
        });
    });
});
