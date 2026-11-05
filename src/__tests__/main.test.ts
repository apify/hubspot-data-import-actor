import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as api from '../api.js';
import { HubspotAuthError } from '../api.js';

const mocks = vi.hoisted(() => ({
    input: {} as Record<string, unknown>,
    items: [] as Record<string, unknown>[],
    pushed: [] as Record<string, unknown>[],
    output: undefined as unknown,
    fail: vi.fn(),
}));

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    Actor: {
        init: vi.fn(),
        exit: vi.fn(),
        on: vi.fn(),
        fail: mocks.fail,
        getInput: async () => mocks.input,
        openKeyValueStore: async () => ({ getValue: async () => null, setValue: vi.fn() }),
        openDataset: async () => ({
            getData: async ({ offset }: { offset: number }) => ({ items: offset === 0 ? mocks.items : [] }),
        }),
        pushData: async (rows: Record<string, unknown>[]) => { mocks.pushed.push(...rows); },
        setValue: async (_key: string, value: unknown) => { mocks.output = value; },
    },
}));

let runCount = 0;

const runMain = async (companies: { url: string; companyId: string }[], items: Record<string, unknown>[]) => {
    mocks.input = {
        hubspotAccessToken: 'tok',
        datasetId: 'ds1',
        importMode: 'contacts',
        companyUrlMapping: companies,
        dataMappings: [{ source: 'email', target: 'email', overwriteMode: 'overwrite' }],
    };
    mocks.items = items;
    // A unique query re-executes main.ts while sharing the (spied) dependency modules.
    runCount++;
    const mainPath = `../main.js?run=${runCount}`;
    await import(/* @vite-ignore */ mainPath);
};

const companyRows = () => mocks.pushed.filter((r) => r.kind === 'company');

beforeEach(() => {
    mocks.pushed = [];
    mocks.output = undefined;
    mocks.fail.mockReset();
    vi.spyOn(api, 'searchContactByEmail').mockResolvedValue(null);
    vi.spyOn(api, 'createContact').mockResolvedValue('c-new');
    vi.spyOn(api, 'associateContactToCompany').mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('main', () => {
    it('treats an explicit empty leadsEnrichment as a valid all-zero row and a missing one as a source error', async () => {
        await runMain(
            [{ url: 'a.com', companyId: '1' }, { url: 'b.com', companyId: '2' }, { url: 'c.com', companyId: '3' }],
            [
                { originalStartUrl: 'https://a.com', leadsEnrichment: [] },
                { originalStartUrl: 'https://b.com' },
                { originalStartUrl: 'https://c.com', leadsEnrichment: [{ email: 'x@c.com' }] },
            ],
        );
        expect(mocks.fail).not.toHaveBeenCalled();
        const [a, b, c] = companyRows();
        expect(a).toMatchObject({ companyId: '1', status: 'imported', created: 0, updated: 0, skipped: 0, failed: 0 });
        expect(a.error).toBeUndefined();
        expect(b).toMatchObject({ companyId: '2', status: 'failed', failed: 0 });
        expect(b.error).toMatch(/missing leadsEnrichment/);
        expect(c).toMatchObject({ companyId: '3', created: 1 });
        expect(mocks.output).toMatchObject({ totalCreated: 1, totalFailed: 0 });
    });

    it('succeeds as no-results when every matched item has an empty leadsEnrichment', async () => {
        await runMain([{ url: 'a.com', companyId: '1' }], [{ originalStartUrl: 'https://a.com', leadsEnrichment: [] }]);
        expect(mocks.fail).not.toHaveBeenCalled();
        expect(mocks.output).toMatchObject({ totalCreated: 0, totalUpdated: 0, totalSkipped: 0, totalFailed: 0 });
    });

    it('pushes partial contacts and the company row before failing on an auth error', async () => {
        vi.mocked(api.searchContactByEmail)
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new HubspotAuthError('/search', 'invalid token'));
        await runMain(
            [{ url: 'a.com', companyId: '1' }, { url: 'b.com', companyId: '2' }],
            [
                { originalStartUrl: 'https://a.com', leadsEnrichment: [{ email: 'x@a.com' }, { email: 'y@a.com' }] },
                { originalStartUrl: 'https://b.com', leadsEnrichment: [{ email: 'z@b.com' }] },
            ],
        );
        expect(mocks.fail).toHaveBeenCalledWith(expect.stringContaining('401'));
        expect(mocks.pushed.map((r) => r.kind)).toEqual(['contact', 'contact', 'company']);
        expect(companyRows()[0]).toMatchObject({ companyId: '1', created: 1, failed: 1 });
        expect(companyRows()[0].error).toContain('401');
    });
});
