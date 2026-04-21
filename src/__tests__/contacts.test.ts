import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { processCompanyLeads } from '../contacts.js';
import { HubspotAuthError } from '../api.js';
import type { DataMapping, LeadsEnrichmentRow } from '../types.js';

const DEFAULT_MAPPINGS: DataMapping[] = [
    { source: 'email', target: 'email' },
    { source: 'firstName', target: 'firstname' },
    { source: 'lastName', target: 'lastname' },
    { source: 'jobTitle', target: 'jobtitle' },
    { source: 'mobileNumber', target: 'phone' },
];

interface FakeResponseInit {
    status?: number;
    body?: unknown;
}

const fakeResponse = ({ status = 200, body }: FakeResponseInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
});

type Call = { url: string; method: string; body: unknown };

const setupFetch = (responses: Array<(call: Call) => FakeResponseInit>) => {
    const calls: Call[] = [];
    let i = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        const call: Call = { url, method: init.method as string, body };
        calls.push(call);
        const handler = responses[i++] ?? (() => ({ status: 200, body: {} }));
        return fakeResponse(handler(call));
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
};

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('processCompanyLeads', () => {
    it('skips leads without an email and does not call HubSpot', async () => {
        const { calls } = setupFetch([]);
        const leads: LeadsEnrichmentRow[] = [{ firstName: 'No', lastName: 'Email' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats).toEqual({ created: 0, updated: 0, skipped: 1, rowsTotal: 1 });
        expect(calls).toHaveLength(0);
    });

    it('creates a contact when search returns no match, then associates it', async () => {
        const { calls } = setupFetch([
            () => ({ body: { results: [] } }),              // search
            () => ({ body: { id: 'contact-new' } }),        // create
            () => ({ status: 204 }),                         // associate
        ]);
        const leads: LeadsEnrichmentRow[] = [
            { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' },
        ];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, rowsTotal: 1 });
        expect(calls[0].url).toContain('/contacts/search');
        expect(calls[1].url).toMatch(/\/crm\/v3\/objects\/contacts$/);
        expect(calls[1].method).toBe('POST');
        expect(calls[1].body).toEqual({
            properties: { email: 'jane@example.com', firstname: 'Jane', lastname: 'Doe' },
        });
        expect(calls[2].url).toContain('/contacts/contact-new/associations/companies/c1/contact_to_company');
        expect(calls[2].method).toBe('PUT');
    });

    it('updates an existing contact when search finds a match', async () => {
        const { calls } = setupFetch([
            () => ({ body: { results: [{ id: 'contact-123' }] } }),
            () => ({ status: 204 }),
            () => ({ status: 204 }),
        ]);
        const leads: LeadsEnrichmentRow[] = [
            { email: 'jane@example.com', firstName: 'Jane', mobileNumber: '+1' },
        ];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats).toEqual({ created: 0, updated: 1, skipped: 0, rowsTotal: 1 });
        expect(calls[1].method).toBe('PATCH');
        expect(calls[1].url).toMatch(/\/contacts\/contact-123$/);
        expect(calls[1].body).toEqual({
            properties: { email: 'jane@example.com', firstname: 'Jane', phone: '+1' },
        });
    });

    it('treats association 409 as success (already associated)', async () => {
        setupFetch([
            () => ({ body: { results: [] } }),
            () => ({ body: { id: 'c-new' } }),
            () => ({ status: 409, body: { message: 'already associated' } }),
        ]);
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats).toEqual({ created: 1, updated: 0, skipped: 0, rowsTotal: 1 });
    });

    it('keeps the created count and captures first error when association fails with 500', async () => {
        setupFetch([
            () => ({ body: { results: [] } }),
            () => ({ body: { id: 'c-new' } }),
            () => ({ status: 500, body: { message: 'boom' } }),
        ]);
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats.created).toBe(1);
        expect(stats.skipped).toBe(0);
        expect(stats.error).toContain('500');
    });

    it('counts row as skipped and captures error when search fails', async () => {
        setupFetch([
            () => ({ status: 500, body: { message: 'server down' } }),
        ]);
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats).toMatchObject({ created: 0, updated: 0, skipped: 1, rowsTotal: 1 });
        expect(stats.error).toContain('500');
    });

    it('propagates 401 from search as HubspotAuthError (does not count as skipped)', async () => {
        setupFetch([
            () => ({ status: 401, body: { message: 'invalid token' } }),
        ]);
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        await expect(processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS))
            .rejects.toBeInstanceOf(HubspotAuthError);
    });

    it('propagates 401 from association as HubspotAuthError', async () => {
        setupFetch([
            () => ({ body: { results: [] } }),
            () => ({ body: { id: 'c-new' } }),
            () => ({ status: 401, body: { message: 'invalid token' } }),
        ]);
        const leads: LeadsEnrichmentRow[] = [{ email: 'a@b.com' }];
        await expect(processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS))
            .rejects.toBeInstanceOf(HubspotAuthError);
    });

    it('processes a mix of skip/create/update rows', async () => {
        setupFetch([
            // row 1: email present → search hit → update → associate
            () => ({ body: { results: [{ id: 'c-1' }] } }),
            () => ({ status: 204 }),
            () => ({ status: 204 }),
            // row 2: no email → skipped (no fetch)
            // row 3: email present → search miss → create → associate
            () => ({ body: { results: [] } }),
            () => ({ body: { id: 'c-3' } }),
            () => ({ status: 204 }),
        ]);
        const leads: LeadsEnrichmentRow[] = [
            { email: 'a@b.com', firstName: 'A' },
            { firstName: 'NoEmail' },
            { email: 'c@d.com', firstName: 'C' },
        ];
        const stats = await processCompanyLeads('tok', 'c1', leads, DEFAULT_MAPPINGS);
        expect(stats).toEqual({ created: 1, updated: 1, skipped: 1, rowsTotal: 3 });
    });
});
