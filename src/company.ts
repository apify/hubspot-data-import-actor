import { Actor, log } from 'apify';
import type { ActorOutput, CompanyResult, DataMapping } from './types.js';
import { validateInput } from './validation.js';
import { filterSkippedProperties, normalizeUrl } from './utils.js';
import {
    COMPANY_BATCH_SIZE,
    HubspotAuthError,
    batchReadCompanies,
    batchUpdateCompanies,
    updateCompany,
} from './api.js';

// importMode: 'company' — writes cleaned Contact Details Scraper output onto the
// company record itself (no contacts). Kept separate from the contacts path on purpose.

const STATE_KEY = 'COMPANY_MIGRATION_STATE';

export const COMPANY_SOURCES = [
    'companyEmail',
    'companyPhone',
    'companyLinkedIn',
    'companyX',
    'companyFacebook',
    'companyInstagram',
    'companyYouTube',
    'companyTikTok',
] as const;

export type CompanySource = (typeof COMPANY_SOURCES)[number];
export type CompanyFields = Partial<Record<CompanySource, string>>;

export interface CompanyPropertiesResult extends CompanyResult {
    propertiesWritten: string[];
    fields: CompanyFields;
}

type DatasetItem = Record<string, unknown>;

// --- Pure cleaning helpers ---

const ensureProtocol = (url: string): string => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

const parseUrl = (raw: string): URL | null => {
    try {
        return new URL(ensureProtocol(raw.trim()));
    } catch {
        return null;
    }
};

const stripWww = (host: string): string => host.toLowerCase().replace(/^www\./, '');

/** Host of the company website without `www.`, e.g. `https://www.Kiwi.com/en` → `kiwi.com`. */
export const companyDomain = (companyUrl: string): string | null => {
    const url = parseUrl(companyUrl);
    return url ? stripWww(url.hostname) : null;
};

const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

// Order = priority. info > contact > hello > sales > support, then the rest of the whitelist.
const ROLE_LOCAL_PARTS = [
    'info',
    'contact',
    'hello',
    'sales',
    'support',
    'help',
    'office',
    'press',
    'team',
    'enquiries',
    'inquiries',
    'admin',
    'service',
    'mail',
    'kontakt',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Priority rank of a role mailbox (`info`, `info-cz`, `info.eu` …), or -1 when not a role address. */
const roleRank = (localPart: string): number =>
    ROLE_LOCAL_PARTS.findIndex(
        (role) => localPart === role || (localPart.startsWith(role) && /^[-._]/.test(localPart.slice(role.length))),
    );

export const pickCompanyEmail = (emails: unknown, domain: string | null): string | undefined => {
    if (!domain) return undefined;
    const seen = new Set<string>();
    let best: { email: string; rank: number } | undefined;
    for (const raw of stringArray(emails)) {
        const email = raw.trim().toLowerCase();
        if (seen.has(email) || !EMAIL_RE.test(email)) continue;
        seen.add(email);
        const [local, emailDomain] = email.split('@');
        if (emailDomain !== domain && !emailDomain.endsWith(`.${domain}`)) continue;
        const rank = roleRank(local);
        if (rank === -1) continue;
        if (!best || rank < best.rank) best = { email, rank };
    }
    return best?.email;
};

export const pickCompanyPhone = (phones: unknown): string | undefined => {
    const first = stringArray(phones)[0];
    return first ? first.trim() : undefined;
};

type SocialPlatform = 'linkedin' | 'x' | 'facebook' | 'instagram' | 'youtube' | 'tiktok';

const PLATFORM_HOSTS: Record<SocialPlatform, string[]> = {
    linkedin: ['linkedin.com'],
    x: ['x.com', 'twitter.com'],
    facebook: ['facebook.com', 'fb.com'],
    instagram: ['instagram.com'],
    youtube: ['youtube.com'],
    tiktok: ['tiktok.com'],
};

// Path segments that mark a share button / post / video rather than the company profile.
const REJECTED_SEGMENTS = new Set([
    'share',
    'sharer',
    'sharer.php',
    'sharearticle',
    'intent',
    'dialog',
    'plugins',
    'embed',
    'shorts',
    'watch',
    'ads',
]);

/** Returns a canonical profile URL for the platform, or null when the URL isn't a company profile. */
export const cleanSocialUrl = (platform: SocialPlatform, raw: string): string | null => {
    const url = parseUrl(raw);
    if (!url) return null;
    const bareHost = stripWww(url.hostname);
    const hostOk = PLATFORM_HOSTS[platform].some((h) => bareHost === h || bareHost.endsWith(`.${h}`));
    if (!hostOk) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const lower = segments.map((s) => s.toLowerCase());
    if (lower.some((s) => REJECTED_SEGMENTS.has(s))) return null;

    let path = segments;
    if (platform === 'linkedin') {
        if (!['company', 'school'].includes(lower[0]) || segments.length < 2) return null;
        path = segments.slice(0, 2);
    }
    if (platform === 'tiktok' && lower.includes('video')) return null;

    const host = platform === 'x' ? 'x.com' : url.hostname.toLowerCase();
    return `https://${host}/${path.join('/')}`;
};

const pickSocial = (platform: SocialPlatform, urls: unknown): string | undefined => {
    for (const raw of stringArray(urls)) {
        const cleaned = cleanSocialUrl(platform, raw);
        if (cleaned) return cleaned;
    }
    return undefined;
};

/** Bare X/Twitter handle (no `@`) from a profile URL or handle string. */
export const toXHandle = (value: string): string => {
    const url = /^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\//i.test(value.trim()) ? parseUrl(value) : null;
    const handle = url ? (url.pathname.split('/').filter(Boolean)[0] ?? '') : value.trim();
    return handle.replace(/^@/, '');
};

/** Computes the 8 clean single-value company sources from one Contact Details Scraper item. */
export const extractCompanyFields = (item: DatasetItem, companyUrl: string): CompanyFields => {
    const domain = companyDomain(companyUrl) ?? (typeof item.domain === 'string' ? stripWww(item.domain) : null);
    const fields: CompanyFields = {
        companyEmail: pickCompanyEmail(item.emails, domain),
        companyPhone: pickCompanyPhone(item.phones),
        companyLinkedIn: pickSocial('linkedin', item.linkedIns),
        companyX: pickSocial('x', item.twitters),
        companyFacebook: pickSocial('facebook', item.facebooks),
        companyInstagram: pickSocial('instagram', item.instagrams),
        companyYouTube: pickSocial('youtube', item.youtubes),
        companyTikTok: pickSocial('tiktok', item.tiktoks),
    };
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as CompanyFields;
};

export const buildCompanyProperties = (
    fields: CompanyFields,
    mappings: ReadonlyArray<Pick<DataMapping, 'source' | 'target'>>,
): Record<string, string> => {
    const properties: Record<string, string> = {};
    for (const { source, target } of mappings) {
        const value = fields[source as CompanySource];
        if (!value) continue;
        properties[target] = source === 'companyX' && target === 'twitterhandle' ? toXHandle(value) : value;
    }
    return properties;
};

// Scraper items can be split per page when mergeContacts is off; fold them into one.
const MERGED_ARRAY_KEYS = ['scrapedUrls', 'emails', 'phones', 'linkedIns', 'twitters', 'facebooks', 'instagrams', 'youtubes', 'tiktoks'];

const mergeItems = (a: DatasetItem, b: DatasetItem): DatasetItem => {
    const merged: DatasetItem = { ...a };
    for (const key of MERGED_ARRAY_KEYS) {
        merged[key] = [...stringArray(a[key]), ...stringArray(b[key])];
    }
    return merged;
};

// --- Run ---

interface CompanyMigrationState {
    results: CompanyPropertiesResult[];
    processedIndex: number;
}

const row = (
    companyId: string,
    companyUrl: string,
    status: CompanyResult['status'],
    extra: { error?: string; propertiesWritten?: string[]; fields?: CompanyFields } = {},
): CompanyPropertiesResult => ({
    kind: 'company',
    companyId,
    companyUrl,
    status,
    created: 0,
    updated: status === 'imported' ? 1 : 0,
    skipped: status === 'skipped' ? 1 : 0,
    rowsTotal: 1,
    ...(extra.error ? { error: extra.error } : {}),
    propertiesWritten: extra.propertiesWritten ?? [],
    fields: extra.fields ?? {},
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface PendingWrite {
    companyId: string;
    companyUrl: string;
    fields: CompanyFields;
    properties: Record<string, string>;
}

/** Skip-mode filter + batch write for one chunk. Only HubspotAuthError escapes. */
const writeChunk = async (
    token: string,
    pending: PendingWrite[],
    skipTargets: string[],
): Promise<Map<string, CompanyPropertiesResult>> => {
    const out = new Map<string, CompanyPropertiesResult>();
    let toWrite = pending;

    if (skipTargets.length > 0 && pending.length > 0) {
        let existing: Map<string, Record<string, unknown>>;
        try {
            existing = await batchReadCompanies(token, pending.map((p) => p.companyId), skipTargets);
        } catch (err) {
            if (err instanceof HubspotAuthError) throw err;
            log.warning(`Batch read of existing company properties failed: ${errorMessage(err)}`);
            for (const p of pending) {
                out.set(p.companyId, row(p.companyId, p.companyUrl, 'failed', { error: `Could not read existing properties: ${errorMessage(err)}`, fields: p.fields }));
            }
            return out;
        }
        toWrite = [];
        for (const p of pending) {
            const properties = filterSkippedProperties(p.properties, existing.get(p.companyId) ?? {}, skipTargets);
            if (Object.keys(properties).length === 0) {
                // Every mapped property already has a value and the mapping says "skip".
                out.set(p.companyId, row(p.companyId, p.companyUrl, 'skipped', { fields: p.fields }));
            } else {
                toWrite.push({ ...p, properties });
            }
        }
    }

    if (toWrite.length === 0) return out;

    let updatedIds = new Set<string>();
    try {
        updatedIds = await batchUpdateCompanies(token, toWrite.map((p) => ({ id: p.companyId, properties: p.properties })));
    } catch (err) {
        if (err instanceof HubspotAuthError) throw err;
        log.warning(`Batch update failed, retrying ${toWrite.length} companies one by one: ${errorMessage(err)}`);
    }

    for (const p of toWrite) {
        const written = { fields: p.fields, propertiesWritten: Object.keys(p.properties) };
        if (updatedIds.has(p.companyId)) {
            out.set(p.companyId, row(p.companyId, p.companyUrl, 'imported', written));
            continue;
        }
        try {
            await updateCompany(token, p.companyId, p.properties);
            out.set(p.companyId, row(p.companyId, p.companyUrl, 'imported', written));
        } catch (err) {
            if (err instanceof HubspotAuthError) throw err;
            log.error(`Failed to update company ${p.companyId}: ${errorMessage(err)}`);
            out.set(p.companyId, row(p.companyId, p.companyUrl, 'failed', { error: errorMessage(err), fields: p.fields }));
        }
    }
    return out;
};

/**
 * Entry point for importMode 'company'. Owns its own error handling: only invalid
 * input or a HubSpot auth error fails the actor; everything else becomes a per-company row.
 */
export const runCompanyImport = async (rawInput: unknown): Promise<void> => {
    const startTime = new Date();
    try {
        const { hubspotAccessToken, datasetId, companyUrlMapping, dataMappings } = validateInput(rawInput);
        const mappings = dataMappings.filter((m) => m.source?.trim() && m.target?.trim());
        const unknownSources = mappings.map((m) => m.source).filter((s) => !(COMPANY_SOURCES as readonly string[]).includes(s));
        if (unknownSources.length > 0) {
            log.warning(`Mapping sources not produced in company mode (ignored): ${unknownSources.map((s) => `"${s}"`).join(', ')}`);
        }
        const skipTargets = [...new Set(mappings.filter((m) => m.overwriteMode === 'skip').map((m) => m.target))];

        const store = await Actor.openKeyValueStore();
        const savedState = await store.getValue<CompanyMigrationState>(STATE_KEY);
        const results: CompanyPropertiesResult[] = savedState?.results ?? [];
        let startIndex = savedState?.processedIndex ?? 0;
        if (startIndex > 0) {
            log.info(`Resuming from company index ${startIndex} (${results.length} results from previous run)`);
        }
        Actor.on('migrating', async () => {
            log.info('Migration event received, persisting state...');
            await store.setValue(STATE_KEY, { results, processedIndex: startIndex } satisfies CompanyMigrationState);
        });

        log.info(`Starting company import for ${companyUrlMapping.length} companies from dataset ${datasetId}`);
        const dataset = await Actor.openDataset(datasetId);
        const itemsByUrl = new Map<string, DatasetItem>();
        const PAGE_SIZE = 50;
        let offset = 0;
        while (true) {
            const { items } = await dataset.getData({ offset, limit: PAGE_SIZE });
            if (!items || items.length === 0) break;
            for (const item of items) {
                const url = item.originalStartUrl;
                if (typeof url !== 'string' || !url) continue;
                const key = normalizeUrl(url);
                const existing = itemsByUrl.get(key);
                itemsByUrl.set(key, existing ? mergeItems(existing, item) : item);
            }
            offset += items.length;
            if (items.length < PAGE_SIZE) break;
        }
        log.info(`Fetched ${offset} items from dataset, mapped ${itemsByUrl.size} unique URLs`);

        const unmatchedCompanies: string[] = [];

        for (let chunkStart = startIndex; chunkStart < companyUrlMapping.length; chunkStart += COMPANY_BATCH_SIZE) {
            const chunk = companyUrlMapping.slice(chunkStart, chunkStart + COMPANY_BATCH_SIZE);
            const decided = new Map<string, CompanyPropertiesResult>();
            const pending: PendingWrite[] = [];

            for (const { url, companyId } of chunk) {
                const companyUrl = url?.trim() ?? '';
                if (!companyUrl) {
                    decided.set(companyId, row(companyId, '', 'skipped', { error: 'No company URL provided' }));
                    continue;
                }
                const item = itemsByUrl.get(normalizeUrl(companyUrl));
                if (!item) {
                    unmatchedCompanies.push(companyUrl);
                    decided.set(companyId, row(companyId, companyUrl, 'skipped', { error: 'No matching dataset item found' }));
                    continue;
                }
                if (stringArray(item.scrapedUrls).length === 0) {
                    decided.set(companyId, row(companyId, companyUrl, 'skipped', { error: 'Website could not be scraped (0 pages)' }));
                    continue;
                }
                const fields = extractCompanyFields(item, companyUrl);
                const properties = buildCompanyProperties(fields, mappings);
                if (Object.keys(properties).length === 0) {
                    decided.set(companyId, row(companyId, companyUrl, 'skipped', { error: 'No mappable data found on the website', fields }));
                    continue;
                }
                pending.push({ companyId, companyUrl, fields, properties });
            }

            const written = await writeChunk(hubspotAccessToken, pending, skipTargets);
            const chunkRows = chunk.map(({ companyId }) => decided.get(companyId) ?? written.get(companyId)!);
            results.push(...chunkRows);
            await Actor.pushData(chunkRows);
            startIndex = chunkStart + chunk.length;
            log.info(`Processed ${startIndex}/${companyUrlMapping.length} companies`);
        }

        const endTime = new Date();
        const output: ActorOutput = {
            totalCompanies: companyUrlMapping.length,
            totalCreated: 0,
            totalUpdated: results.reduce((sum, r) => sum + r.updated, 0),
            totalSkipped: results.reduce((sum, r) => sum + r.skipped, 0),
            totalRows: results.length,
            unmatchedCompanies,
            results,
            datasetId,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            duration: (endTime.getTime() - startTime.getTime()) / 1000,
        };
        await Actor.setValue('OUTPUT', output);
        await store.setValue(STATE_KEY, null);

        log.info('Company import complete!', {
            totalCompanies: output.totalCompanies,
            totalUpdated: output.totalUpdated,
            totalSkipped: output.totalSkipped,
            totalFailed: results.filter((r) => r.status === 'failed').length,
            duration: output.duration,
        });
    } catch (err) {
        log.error('Company import failed', {
            error: errorMessage(err),
            stack: err instanceof Error ? err.stack : undefined,
        });
        await Actor.fail(errorMessage(err));
    }
};
