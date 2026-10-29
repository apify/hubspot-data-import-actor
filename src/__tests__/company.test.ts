import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DataMapping } from '../types.js';

const actorMock = vi.hoisted(() => ({
    items: [] as Record<string, unknown>[],
    pushed: [] as Record<string, unknown>[],
    failed: undefined as string | undefined,
}));

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    Actor: {
        openKeyValueStore: async () => ({ getValue: async () => null, setValue: async () => undefined }),
        on: vi.fn(),
        openDataset: async () => ({
            getData: async ({ offset, limit }: { offset: number; limit: number }) => ({
                items: actorMock.items.slice(offset, offset + limit),
            }),
        }),
        pushData: async (rows: Record<string, unknown>[]) => {
            actorMock.pushed.push(...rows);
        },
        setValue: async () => undefined,
        fail: async (msg: string) => {
            actorMock.failed = msg;
        },
    },
}));

const api = await import('../api.js');
const { buildCompanyProperties, cleanSocialUrl, extractCompanyFields, pickCompanyEmail, runCompanyImport, toXHandle } =
    await import('../company.js');

// Fixtures trimmed from a real Contact Details Scraper run (mergeContacts: true).
const base = {
    depth: 0,
    scrapedUrls: ['https://example.com/'],
    emails: [],
    phones: [],
    phonesUncertain: [],
    linkedIns: [],
    twitters: [],
    instagrams: [],
    facebooks: [],
    youtubes: [],
    tiktoks: [],
    leadsEnrichment: [],
};

const kiwi = {
    ...base,
    originalStartUrl: 'https://kiwi.com',
    domain: 'kiwi.com',
    emails: ['contact@support.kiwi.com', 'privacy-dpo@kiwi.com'],
    phones: ['+972039723333'],
    linkedIns: ['https://www.linkedin.com/company/kiwi', 'https://www.linkedin.com/company/Kiwi'],
    twitters: ['https://twitter.com/kiwicom247'],
    tiktoks: ['https://www.tiktok.com/@kiwi.com', 'https://www.tiktok.com/@kiwicom247'],
};

const hotjar = {
    ...base,
    originalStartUrl: 'https://hotjar.com',
    domain: 'hotjar.com',
    emails: ['press@contentsquare.com', 'people.ops@contentsquare.com'],
};

const allbirds = {
    ...base,
    originalStartUrl: 'https://allbirds.com',
    domain: 'allbirds.com',
    emails: ['help@allbirds.com', 'HELP@ALLBIRDS.COM'],
    phonesUncertain: ['1434976336', '+1 (424) 363-8064'],
};

const basecamp = {
    ...base,
    originalStartUrl: 'https://basecamp.com',
    domain: 'basecamp.com',
    emails: ['jason@basecamp.com', 'support@basecamp.com', 'nonprofits@basecamp.com'],
    phonesUncertain: ['8675309'],
};

const buffer = {
    ...base,
    originalStartUrl: 'https://buffer.com',
    domain: 'buffer.com',
    emails: ['press@buffer.com'],
    linkedIns: ['https://www.linkedin.com/company/bufferapp', 'https://www.linkedin.com/in/joelgascoigne'],
    twitters: ['https://x.com/buffer', 'https://x.com/Buffer'],
    youtubes: [
        'https://www.youtube.com/embed/1e3iWdwAVSk',
        'https://www.youtube.com/ads',
        'https://www.youtube.com/bufferapp',
    ],
};

const pipedrive = {
    ...base,
    originalStartUrl: 'https://pipedrive.com',
    domain: 'pipedrive.com',
    phones: [],
    phonesUncertain: ['2022-2023', '101382096', '11958539'],
    linkedIns: ['https://www.linkedin.com/company/pipedrive'],
    twitters: ['https://x.com/pipedrive', 'https://twitter.com/pipedrive', 'https://www.twitter.com/pipedrive'],
    instagrams: ['https://www.instagram.com/pipedrive', 'https://www.instagram.com/lifeatpipedrive'],
    facebooks: ['https://www.facebook.com/pipedrive'],
    youtubes: ['https://www.youtube.com/@pipedrive', 'https://www.youtube.com/watch?v=_C_H7-s7dAA'],
};

const joes = {
    ...base,
    originalStartUrl: 'https://www.joesstonecrab.com',
    domain: 'joesstonecrab.com',
    emails: ['info@joesstonecrab.com'],
    phones: ['(305) 673-0365', '(305) 673-4611'],
    instagrams: ['https://www.instagram.com/joesstonecrab'],
};

const blocked = {
    ...base,
    originalStartUrl: 'https://www.fieldfisher.com',
    domain: 'fieldfisher.com',
    scrapedUrls: [],
};

describe('extractCompanyFields — email', () => {
    it('accepts a role mailbox on a subdomain of the company domain (kiwi)', () => {
        expect(extractCompanyFields(kiwi, 'https://kiwi.com').companyEmail).toBe('contact@support.kiwi.com');
    });

    it('rejects emails on another domain (hotjar → contentsquare)', () => {
        expect(extractCompanyFields(hotjar, 'https://hotjar.com').companyEmail).toBeUndefined();
    });

    it('lowercases and dedupes (allbirds HELP@)', () => {
        expect(extractCompanyFields(allbirds, 'https://allbirds.com').companyEmail).toBe('help@allbirds.com');
    });

    it('rejects personal mailboxes (basecamp founder)', () => {
        expect(extractCompanyFields(basecamp, 'https://basecamp.com').companyEmail).toBe('support@basecamp.com');
    });

    it('prefers info > contact > hello > sales > support', () => {
        const emails = ['support@acme.com', 'sales@acme.com', 'hello@acme.com', 'contact@acme.com', 'info@acme.com'];
        expect(pickCompanyEmail(emails, 'acme.com')).toBe('info@acme.com');
        expect(pickCompanyEmail(emails.slice(0, 4), 'acme.com')).toBe('contact@acme.com');
        expect(pickCompanyEmail(['support@acme.com', 'sales@acme.com'], 'acme.com')).toBe('sales@acme.com');
    });

    it('accepts info-* style prefixes but not look-alike local parts', () => {
        expect(pickCompanyEmail(['info-cz@acme.com'], 'acme.com')).toBe('info-cz@acme.com');
        expect(pickCompanyEmail(['information@acme.com', 'mailroom@acme.com'], 'acme.com')).toBeUndefined();
    });

    it('rejects domains that only end with the company domain', () => {
        expect(pickCompanyEmail(['info@notacme.com'], 'acme.com')).toBeUndefined();
    });

    it('strips www from the company URL host', () => {
        expect(extractCompanyFields(joes, 'https://www.joesstonecrab.com').companyEmail).toBe('info@joesstonecrab.com');
    });
});

describe('extractCompanyFields — phone', () => {
    it('takes phones[0] (joesstonecrab)', () => {
        expect(extractCompanyFields(joes, 'https://www.joesstonecrab.com').companyPhone).toBe('(305) 673-0365');
    });

    it('never falls back to phonesUncertain (pipedrive, allbirds)', () => {
        expect(extractCompanyFields(pipedrive, 'https://pipedrive.com').companyPhone).toBeUndefined();
        expect(extractCompanyFields(allbirds, 'https://allbirds.com').companyPhone).toBeUndefined();
    });
});

describe('extractCompanyFields — socials', () => {
    it('keeps LinkedIn /company/ and drops /in/ (buffer)', () => {
        expect(extractCompanyFields(buffer, 'https://buffer.com').companyLinkedIn).toBe(
            'https://www.linkedin.com/company/bufferapp',
        );
        expect(cleanSocialUrl('linkedin', 'https://www.linkedin.com/in/joelgascoigne')).toBeNull();
    });

    it('keeps LinkedIn /school/ and trims sub-pages', () => {
        expect(cleanSocialUrl('linkedin', 'https://www.linkedin.com/school/mit/about/')).toBe(
            'https://www.linkedin.com/school/mit',
        );
    });

    it('collapses twitter.com to x.com (pipedrive)', () => {
        const fields = extractCompanyFields(pipedrive, 'https://pipedrive.com');
        expect(fields.companyX).toBe('https://x.com/pipedrive');
        expect(toXHandle(fields.companyX!)).toBe('pipedrive');
        expect(cleanSocialUrl('x', 'https://www.twitter.com/productboard/')).toBe('https://x.com/productboard');
    });

    it('drops youtube watch links but keeps the channel (pipedrive)', () => {
        expect(extractCompanyFields(pipedrive, 'https://pipedrive.com').companyYouTube).toBe(
            'https://www.youtube.com/@pipedrive',
        );
        expect(cleanSocialUrl('youtube', 'https://www.youtube.com/watch?v=_C_H7-s7dAA')).toBeNull();
    });

    it('skips youtube /embed/ and /ads (buffer)', () => {
        expect(extractCompanyFields(buffer, 'https://buffer.com').companyYouTube).toBe(
            'https://www.youtube.com/bufferapp',
        );
    });

    it('drops shorts, share/intent links and tiktok videos', () => {
        expect(cleanSocialUrl('youtube', 'https://www.youtube.com/shorts/abc')).toBeNull();
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/sharer/sharer.php?u=x')).toBeNull();
        expect(cleanSocialUrl('x', 'https://twitter.com/intent/tweet?text=hi')).toBeNull();
        expect(cleanSocialUrl('linkedin', 'https://www.linkedin.com/shareArticle?url=x')).toBeNull();
        expect(cleanSocialUrl('tiktok', 'https://www.tiktok.com/@acme/video/123')).toBeNull();
    });

    it('trims instagram and x post links to the profile, rejects post-only links', () => {
        expect(cleanSocialUrl('instagram', 'https://www.instagram.com/acme/reel/123/')).toBe(
            'https://www.instagram.com/acme',
        );
        expect(cleanSocialUrl('instagram', 'https://www.instagram.com/p/abc/')).toBeNull();
        expect(cleanSocialUrl('instagram', 'https://www.instagram.com/reel/abc/')).toBeNull();
        const x = cleanSocialUrl('x', 'https://twitter.com/acme/status/1');
        expect(x).toBe('https://x.com/acme');
        expect(toXHandle(x!)).toBe('acme');
        expect(cleanSocialUrl('x', 'https://x.com/i/web/status/1')).toBeNull();
    });

    it('trims facebook posts/videos, keeps profile.php ids and pages/ paths', () => {
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/acme/posts/123')).toBe(
            'https://www.facebook.com/acme',
        );
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/acme/videos/1/')).toBe(
            'https://www.facebook.com/acme',
        );
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/profile.php?id=123&ref=x')).toBe(
            'https://www.facebook.com/profile.php?id=123',
        );
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/profile.php')).toBeNull();
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/pages/Acme-Inc/123456/')).toBe(
            'https://www.facebook.com/pages/Acme-Inc/123456',
        );
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/groups/acme')).toBeNull();
    });

    it('strips query, hash and trailing slash and forces https', () => {
        expect(cleanSocialUrl('instagram', 'http://www.instagram.com/acme/?hl=en#top')).toBe(
            'https://www.instagram.com/acme',
        );
    });

    it('rejects bare platform roots and foreign hosts', () => {
        expect(cleanSocialUrl('facebook', 'https://www.facebook.com/')).toBeNull();
        expect(cleanSocialUrl('facebook', 'https://example.com/facebook')).toBeNull();
    });

    it('takes the first clean URL per platform (kiwi)', () => {
        const fields = extractCompanyFields(kiwi, 'https://kiwi.com');
        expect(fields.companyLinkedIn).toBe('https://www.linkedin.com/company/kiwi');
        expect(fields.companyTikTok).toBe('https://www.tiktok.com/@kiwi.com');
    });

    it('omits fields with no usable value', () => {
        expect(extractCompanyFields(hotjar, 'https://hotjar.com')).toEqual({});
    });
});

describe('toXHandle', () => {
    it('extracts the bare handle', () => {
        expect(toXHandle('https://x.com/pipedrive')).toBe('pipedrive');
        expect(toXHandle('https://twitter.com/@acme/status/1')).toBe('acme');
        expect(toXHandle('@acme')).toBe('acme');
    });
});

describe('buildCompanyProperties', () => {
    it('maps sources to targets and writes companyX → twitterhandle as a handle', () => {
        const fields = extractCompanyFields(pipedrive, 'https://pipedrive.com');
        const props = buildCompanyProperties(fields, [
            { source: 'companyX', target: 'twitterhandle' },
            { source: 'companyLinkedIn', target: 'linkedin_company_page' },
            { source: 'companyPhone', target: 'phone' },
            { source: 'companyX', target: 'x_url' },
        ]);
        expect(props).toEqual({
            twitterhandle: 'pipedrive',
            linkedin_company_page: 'https://www.linkedin.com/company/pipedrive',
            x_url: 'https://x.com/pipedrive',
        });
    });
});

describe('runCompanyImport', () => {
    const MAPPINGS: DataMapping[] = [
        { source: 'companyLinkedIn', target: 'linkedin_company_page', overwriteMode: 'overwrite' },
        { source: 'companyX', target: 'twitterhandle', overwriteMode: 'overwrite' },
        { source: 'companyPhone', target: 'phone', overwriteMode: 'skip' },
    ];
    const input = (companyUrlMapping: { url?: string; companyId: string }[], dataMappings = MAPPINGS) => ({
        hubspotAccessToken: 'tok',
        datasetId: 'ds',
        importMode: 'company',
        companyUrlMapping,
        dataMappings,
    });

    let batchRead: ReturnType<typeof vi.spyOn>;
    let batchUpdate: ReturnType<typeof vi.spyOn>;
    let update: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        actorMock.items = [kiwi, hotjar, pipedrive, joes, blocked];
        actorMock.pushed = [];
        actorMock.failed = undefined;
        batchRead = vi.spyOn(api, 'batchReadCompanies').mockResolvedValue(new Map());
        batchUpdate = vi
            .spyOn(api, 'batchUpdateCompanies')
            .mockImplementation(async (_t, updates) => new Set(updates.map((u) => u.id)));
        update = vi.spyOn(api, 'updateCompany').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('pushes one row per company with skip reasons', async () => {
        await runCompanyImport(
            input([
                { url: 'kiwi.com', companyId: '1' },
                { url: 'https://hotjar.com', companyId: '2' },
                { url: 'https://fieldfisher.com', companyId: '3' },
                { url: 'https://unknown.com', companyId: '4' },
                { companyId: '5' },
            ]),
        );
        expect(actorMock.failed).toBeUndefined();
        expect(actorMock.pushed).toHaveLength(5);
        const [k, h, f, u, n] = actorMock.pushed;
        expect(k).toMatchObject({
            kind: 'company',
            companyId: '1',
            status: 'imported',
            created: 0,
            updated: 1,
            skipped: 0,
            rowsTotal: 1,
            propertiesWritten: ['linkedin_company_page', 'twitterhandle', 'phone'],
        });
        expect(k.error).toBeUndefined();
        expect(h).toMatchObject({ status: 'skipped', updated: 0, skipped: 1, error: 'No mappable data found on the website' });
        expect(f).toMatchObject({ status: 'skipped', skipped: 1, error: 'Website could not be scraped (0 pages)' });
        expect(u).toMatchObject({ status: 'skipped', skipped: 1, error: 'No matching dataset item found' });
        expect(n).toMatchObject({ status: 'skipped', skipped: 1, error: 'No company URL provided' });
        expect(batchUpdate).toHaveBeenCalledTimes(1);
        expect(batchUpdate.mock.calls[0][1]).toEqual([
            {
                id: '1',
                properties: {
                    linkedin_company_page: 'https://www.linkedin.com/company/kiwi',
                    twitterhandle: 'kiwicom247',
                    phone: '+972039723333',
                },
            },
        ]);
    });

    it('filters skip-mode targets that already have a value; all filtered → skipped without error', async () => {
        batchRead.mockResolvedValue(new Map([['1', { phone: '+1 555' }], ['2', { phone: '+1 555' }]]));
        await runCompanyImport(
            input(
                [
                    { url: 'https://kiwi.com', companyId: '1' },
                    { url: 'https://www.joesstonecrab.com', companyId: '2' },
                ],
                [
                    { source: 'companyLinkedIn', target: 'linkedin_company_page', overwriteMode: 'overwrite' },
                    { source: 'companyPhone', target: 'phone', overwriteMode: 'skip' },
                ],
            ),
        );
        expect(batchRead).toHaveBeenCalledWith('tok', ['1', '2'], ['phone']);
        const [k, j] = actorMock.pushed;
        expect(k).toMatchObject({ status: 'imported', propertiesWritten: ['linkedin_company_page'] });
        expect(j).toMatchObject({ status: 'skipped', skipped: 1, updated: 0 });
        expect(j.error).toBeUndefined();
    });

    it('falls back to per-company updates when the batch fails and attributes errors', async () => {
        batchUpdate.mockRejectedValue(new api.HubspotApiError(400, 'bad', '/batch'));
        update.mockImplementation(async (_t: string, id: string) => {
            if (id === '2') throw new api.HubspotApiError(404, 'not found', `/companies/${id}`);
        });
        await runCompanyImport(
            input([
                { url: 'https://kiwi.com', companyId: '1' },
                { url: 'https://pipedrive.com', companyId: '2' },
            ]),
        );
        expect(update).toHaveBeenCalledTimes(2);
        const [k, p] = actorMock.pushed;
        expect(k).toMatchObject({ status: 'imported', updated: 1 });
        expect(p).toMatchObject({ status: 'failed', updated: 0, skipped: 0 });
        expect(p.error).toContain('404');
        expect(actorMock.failed).toBeUndefined();
    });

    it('fails the actor on a HubSpot auth error', async () => {
        batchUpdate.mockRejectedValue(new api.HubspotAuthError('/batch', 'expired'));
        await runCompanyImport(input([{ url: 'https://kiwi.com', companyId: '1' }]));
        expect(actorMock.failed).toContain('401');
    });

    it('fails the actor on invalid input', async () => {
        await runCompanyImport({ ...input([{ url: 'https://kiwi.com', companyId: '1' }]), dataMappings: [] });
        expect(actorMock.failed).toBeDefined();
    });
});
