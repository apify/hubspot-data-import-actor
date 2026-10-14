import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { processCompanyLeads } from '../contacts.js';
import { HubspotApiError, HubspotAuthError } from '../api.js';
import type { DataMapping, LeadsEnrichmentRow } from '../types.js';
import type { ContactProgress } from '../contacts.js';
import * as api from '../api.js';

const DEFAULT_MAPPINGS: DataMapping[] = [
    { source: 'email', target: 'email', overwriteMode: 'overwrite' },
    { source: 'firstName', target: 'firstname', overwriteMode: 'overwrite' },
    { source: 'lastName', target: 'lastname', overwriteMode: 'overwrite' },
    { source: 'jobTitle', target: 'jobtitle', overwriteMode: 'overwrite' },
    { source: 'mobileNumber', target: 'phone', overwriteMode: 'overwrite' },
];

const run = (
    leads: LeadsEnrichmentRow[],
    mappings: DataMapping[] = DEFAULT_MAPPINGS,
    deduplication: 'email' | 'phone' = 'email',
    onlyVerifiedEmails = false,
    sink?: (progress: ContactProgress) => Promise<void>,
) => processCompanyLeads('tok', 'c1', 0, leads, mappings, deduplication, onlyVerifiedEmails, sink);

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
        const { stats } = await run(leads);
        expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0, rowsTotal: 1 });
        expect(searchByEmail).not.toHaveBeenCalled();
    });

    it('creates a contact when search returns no match, then associates it', async () => {
        create.mockResolvedValueOnce('contact-new');
        const leads: LeadsEnrichmentRow[] = [
            { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' },
        ];
        const { stats } = await run(leads);
        expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0, rowsTotal: 1 });
        expect(create).toHaveBeenCalledWith('tok', { email: 'jane@example.com', firstname: 'Jane', lastname: 'Doe' });
        expect(associate).toHaveBeenCalledWith('tok', 'contact-new', 'c1');
    });

    it('updates an existing contact when search finds a match', async () => {
        searchByEmail.mockResolvedValueOnce({ id: 'contact-123', properties: {} });
        const leads: LeadsEnrichmentRow[] = [
            { email: 'jane@example.com', firstName: 'Jane', mobileNumber: '+1' },
        ];
        const { stats } = await run(leads);
        expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0, rowsTotal: 1 });
        expect(update).toHaveBeenCalledWith('tok', 'contact-123', {
            email: 'jane@example.com', firstname: 'Jane', phone: '+1',
        });
        expect(associate).toHaveBeenCalledWith('tok', 'contact-123', 'c1');
    });

    it('captures first error when association fails with non-auth error (write stays counted)', async () => {
        searchByEmail.mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('c-new');
        associate.mockRejectedValueOnce(new HubspotApiError(500, 'boom', '/assoc'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const { stats, contacts } = await run(leads);
        expect(stats.created).toBe(1);
        expect(stats.skipped).toBe(0);
        expect(stats.failed).toBe(0); // the write is confirmed; association is surfaced, not failed
        expect(stats.error).toContain('Association failed');
        expect(contacts[0].status).toBe('created');
        expect(contacts[0].errorMessage).toContain('Association failed');
        expect(contacts[0].errorMessage).toContain('500');
    });

    it('counts a failed contact write as failed (never skipped)', async () => {
        searchByEmail.mockRejectedValueOnce(new HubspotApiError(500, 'server down', '/search'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const { stats } = await run(leads);
        expect(stats).toMatchObject({ created: 0, updated: 0, skipped: 0, failed: 1, rowsTotal: 1 });
        expect(stats.error).toContain('500');
    });

    it('continues after an ordinary API failure and processes the next lead', async () => {
        searchByEmail
            .mockRejectedValueOnce(new HubspotApiError(500, 'server down', '/search'))
            .mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('c-2');
        const leads: LeadsEnrichmentRow[] = [
            { email: 'a@b.com' },
            { email: 'c@d.com', firstName: 'C' },
        ];
        const { stats, processingComplete } = await run(leads);
        expect(processingComplete).toBe(true);
        expect(stats).toMatchObject({ created: 1, failed: 1, skipped: 0, updated: 0, rowsTotal: 2 });
    });

    it('stops with an incomplete result on an auth failure (no throw) and preserves prior writes', async () => {
        searchByEmail
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new HubspotAuthError('/search', 'invalid token'));
        create.mockResolvedValueOnce('c-1');
        const leads: LeadsEnrichmentRow[] = [
            { email: 'a@b.com' },
            { email: 'c@d.com' },
            { email: 'e@f.com' },
        ];
        const { stats, processingComplete, stopReason, contacts } = await run(leads);
        expect(processingComplete).toBe(false);
        expect(stopReason).toBe('auth_failed');
        // First lead's confirmed create survives; second lead counts failed;
        // the third is never attempted.
        expect(stats).toMatchObject({ created: 1, failed: 1, rowsTotal: 3 });
        expect(create).toHaveBeenCalledTimes(1);
        expect(contacts.some((c) => c.status === 'failed')).toBe(true);
    });

    it('stops with an incomplete result when association hits auth (write preserved)', async () => {
        searchByEmail.mockResolvedValueOnce(null);
        create.mockResolvedValueOnce('c-new');
        associate.mockRejectedValueOnce(new HubspotAuthError('/assoc', 'invalid token'));
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }, { email: 'c@d.com' }];
        const { stats, processingComplete, stopReason } = await run(leads);
        expect(processingComplete).toBe(false);
        expect(stopReason).toBe('auth_failed');
        expect(stats.created).toBe(1); // confirmed write retained
        expect(stats.error).toContain('Association failed');
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
        const { stats } = await run(leads);
        expect(stats).toEqual({ created: 1, updated: 1, skipped: 1, failed: 0, rowsTotal: 3 });
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
            const { stats } = await run(leads, mappings);
            expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0, rowsTotal: 1 });
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
            const { stats } = await run(leads, mappings);
            expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0, rowsTotal: 1 });
        });

        it('still creates a new contact with all fields when no match is found, regardless of skip flags', async () => {
            const mappings: DataMapping[] = [
                { source: 'email', target: 'email', overwriteMode: 'overwrite' },
                { source: 'jobTitle', target: 'jobtitle', overwriteMode: 'skip' },
            ];
            create.mockResolvedValueOnce('c-new');
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', jobTitle: 'New Title' },
            ];
            const { stats } = await run(leads, mappings);
            expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0, rowsTotal: 1 });
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
            const { stats } = await run(leads, mappings);
            expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0, rowsTotal: 1 });
            expect(update).not.toHaveBeenCalled();
            // v1 behavior: already-complete contacts are still associated.
            expect(associate).toHaveBeenCalledWith('tok', 'c-123', 'c1');
        });
    });

    describe('phone deduplication', () => {
        it('skips leads without a mobileNumber when dedup is phone', async () => {
            const leads: LeadsEnrichmentRow[] = [
                { email: 'has@email.com', firstName: 'NoPhone' },
            ];
            const { stats } = await run(leads, DEFAULT_MAPPINGS, 'phone');
            expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0, rowsTotal: 1 });
            expect(searchByPhone).not.toHaveBeenCalled();
        });

        it('searches by phone and creates when no match', async () => {
            create.mockResolvedValueOnce('c-phone-new');
            const leads: LeadsEnrichmentRow[] = [
                { mobileNumber: '+15551234567', firstName: 'Jane' },
            ];
            const { stats } = await run(leads, DEFAULT_MAPPINGS, 'phone');
            expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0, rowsTotal: 1 });
            expect(searchByPhone).toHaveBeenCalledWith('tok', '+15551234567', []);
            expect(create).toHaveBeenCalledWith('tok', { phone: '+15551234567', firstname: 'Jane' });
            expect(associate).toHaveBeenCalledWith('tok', 'c-phone-new', 'c1');
        });

        it('searches by phone and updates on match', async () => {
            searchByPhone.mockResolvedValueOnce({ id: 'c-phone-existing', properties: {} });
            const leads: LeadsEnrichmentRow[] = [
                { mobileNumber: '+15551234567', firstName: 'Jane' },
            ];
            const { stats } = await run(leads, DEFAULT_MAPPINGS, 'phone');
            expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0, rowsTotal: 1 });
            expect(update).toHaveBeenCalledWith('tok', 'c-phone-existing', expect.any(Object));
        });
    });

    describe('per-individual contact results', () => {
        it('emits skipped_no_identifier with empty identifier for leads missing the dedup value', async () => {
            const leads: LeadsEnrichmentRow[] = [{ firstName: 'No', lastName: 'Email' }];
            const { contacts } = await run(leads);
            expect(contacts).toEqual([{
                kind: 'contact',
                resultVersion: 2,
                resultId: 'contact:c1:0:0',
                sourceIndex: 0,
                companyId: 'c1',
                status: 'skipped_no_identifier',
                identifier: '',
                displayName: 'No Email',
                propertiesWritten: [],
            }]);
        });

        it('emits created with propertiesWritten covering all mapped target fields', async () => {
            create.mockResolvedValueOnce('c-new');
            const leads: LeadsEnrichmentRow[] = [
                { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe' },
            ];
            const { contacts } = await run(leads);
            expect(contacts).toHaveLength(1);
            expect(contacts[0]).toMatchObject({
                kind: 'contact',
                resultVersion: 2,
                companyId: 'c1',
                status: 'created',
                identifier: 'jane@example.com',
                displayName: 'Jane Doe',
            });
            expect(contacts[0].propertiesWritten).toEqual(
                expect.arrayContaining(['email', 'firstname', 'lastname']),
            );
        });

        it('emits updated with propertiesWritten listing only fields actually sent to HubSpot', async () => {
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
            const { contacts } = await run(leads, mappings);
            expect(contacts[0]).toMatchObject({
                kind: 'contact',
                status: 'updated',
                identifier: 'a@b.com',
                displayName: 'Jane',
                propertiesWritten: ['email', 'firstname'],
            });
        });

        it('emits skipped_already_complete with empty propertiesWritten when every mapped field is preserved', async () => {
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
            const { contacts } = await run(leads, mappings);
            expect(contacts[0]).toMatchObject({
                kind: 'contact',
                status: 'skipped_already_complete',
                identifier: 'a@b.com',
                propertiesWritten: [],
            });
        });

        it('emits failed with errorMessage when the contact write throws', async () => {
            searchByEmail.mockRejectedValueOnce(new HubspotApiError(500, 'server down', '/search'));
            const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com', firstName: 'A' }];
            const { contacts } = await run(leads);
            expect(contacts[0]).toMatchObject({
                kind: 'contact',
                status: 'failed',
                identifier: 'a@b.com',
                displayName: 'A',
                propertiesWritten: [],
            });
            expect(contacts[0].errorMessage).toContain('500');
        });

        it('falls back to firstName + lastName when fullName is missing', async () => {
            create.mockResolvedValueOnce('c-new');
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'Foo', lastName: 'Bar' },
            ];
            const { contacts } = await run(leads);
            expect(contacts[0].displayName).toBe('Foo Bar');
        });
    });

    describe('progress sink', () => {
        it('hands the running stats and the completed contact to the sink per lead', async () => {
            create.mockResolvedValueOnce('c-new');
            const sinkCalls: ContactProgress[] = [];
            const sink = async (progress: ContactProgress) => {
                sinkCalls.push(progress);
            };
            const leads: LeadsEnrichmentRow[] = [
                { firstName: 'NoEmail' },
                { email: 'a@b.com' },
            ];
            const { stats } = await run(leads, DEFAULT_MAPPINGS, 'email', false, sink);

            expect(sinkCalls).toHaveLength(2);
            expect(sinkCalls[0]).toMatchObject({ leadIndex: 0, stats: { skipped: 1, rowsTotal: 2 } });
            expect(sinkCalls[0].contact.status).toBe('skipped_no_identifier');
            expect(sinkCalls[1]).toMatchObject({ leadIndex: 1, stats: { created: 1, rowsTotal: 2 } });
            expect(sinkCalls[1].contact.status).toBe('created');
            expect(stats.created).toBe(1);
        });

        it('stops further CRM writes when the sink (progress persistence) fails', async () => {
            const sink = vi.fn(async () => {
                if (sink.mock.calls.length >= 1) throw new Error('state write failed');
            });
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com' },
                { email: 'c@d.com' },
            ];
            const { stats, processingComplete, stopReason } = await run(leads, DEFAULT_MAPPINGS, 'email', false, sink);

            expect(processingComplete).toBe(false);
            expect(stopReason).toBe('progress_persist_failed');
            // First lead confirmed + counted; second never attempted.
            expect(stats).toMatchObject({ created: 1, failed: 0, rowsTotal: 2 });
            expect(create).toHaveBeenCalledTimes(1);
        });

        it('carries stable result ids across rows (companyIndex + lead index)', async () => {
            create.mockResolvedValueOnce('c-new');
            const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }, { email: 'b@c.com' }];
            const { contacts } = await processCompanyLeads('tok', 'c1', 3, leads, DEFAULT_MAPPINGS, 'email', false);
            expect(contacts.map((c) => c.resultId)).toEqual(['contact:c1:3:0', 'contact:c1:3:1']);
            expect(contacts.every((c) => c.resultVersion === 2)).toBe(true);
        });
    });

    describe('onlyVerifiedEmails', () => {
        it('imports a lead when emailVerification result is ok', async () => {
            create.mockResolvedValueOnce('c-verified');
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'Verified', emailVerification: { result: 'ok' } },
            ];
            const { stats } = await run(leads, DEFAULT_MAPPINGS, 'email', true);
            expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0, rowsTotal: 1 });
        });

        it('skips lead when emailVerification result is not ok', async () => {
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'Bad', emailVerification: { result: 'invalid' } },
            ];
            const { stats, contacts } = await run(leads, DEFAULT_MAPPINGS, 'email', true);
            expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0, rowsTotal: 1 });
            expect(searchByEmail).not.toHaveBeenCalled();
            expect(contacts[0]).toMatchObject({ status: 'skipped_unverified_email', identifier: '', propertiesWritten: [] });
        });

        it('skips lead when emailVerification block is missing', async () => {
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'NoVerification' },
            ];
            const { stats, contacts } = await run(leads, DEFAULT_MAPPINGS, 'email', true);
            expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, failed: 0, rowsTotal: 1 });
            expect(searchByEmail).not.toHaveBeenCalled();
            expect(contacts[0]).toMatchObject({ status: 'skipped_unverified_email', identifier: '', propertiesWritten: [] });
        });

        it('imports lead with unverified email when flag is off', async () => {
            create.mockResolvedValueOnce('c-unverified');
            const leads: LeadsEnrichmentRow[] = [
                { email: 'a@b.com', firstName: 'Unverified', emailVerification: { result: 'invalid' } },
            ];
            const { stats } = await run(leads, DEFAULT_MAPPINGS, 'email', false);
            expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0, rowsTotal: 1 });
        });
    });
});