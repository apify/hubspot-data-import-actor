import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { postImportCallback } from '../callback.js';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('postImportCallback', () => {
    it('POSTs to the callback URL with correct query params and body', async () => {
        const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>(
            async () => ({ ok: true, status: 200, text: async () => '' }),
        );
        vi.stubGlobal('fetch', fetchMock);

        await postImportCallback(
            'https://backend.example.com/hubspot/config/runs/import-callback',
            'run-1',
            'secret-1',
            'company-1',
            { created: 2, updated: 3, skipped: 1, rowsTotal: 6 },
        );

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/hubspot/config/runs/import-callback');
        expect(parsed.searchParams.get('runId')).toBe('run-1');
        expect(parsed.searchParams.get('companyId')).toBe('company-1');
        expect(parsed.searchParams.get('runSecret')).toBe('secret-1');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            created: 2, updated: 3, skipped: 1, rowsTotal: 6,
        });
    });

    it('includes the error field when set', async () => {
        const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>(
            async () => ({ ok: true, status: 200, text: async () => '' }),
        );
        vi.stubGlobal('fetch', fetchMock);

        await postImportCallback('https://b.example.com/cb', 'r', 's', 'c', {
            created: 0, updated: 0, skipped: 1, rowsTotal: 1, error: 'boom',
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.error).toBe('boom');
    });

    it('swallows fetch rejections without throwing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network down');
        }));
        await expect(
            postImportCallback('https://b.example.com/cb', 'r', 's', 'c', {
                created: 0, updated: 0, skipped: 0, rowsTotal: 0,
            }),
        ).resolves.toBeUndefined();
    });

    it('swallows non-2xx responses without throwing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'nope' })));
        await expect(
            postImportCallback('https://b.example.com/cb', 'r', 's', 'c', {
                created: 0, updated: 0, skipped: 0, rowsTotal: 0,
            }),
        ).resolves.toBeUndefined();
    });
});
