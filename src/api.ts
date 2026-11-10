import { Client } from '@hubspot/api-client';
import { log } from 'apify';
import type { ContactImportStats, ContactResult } from './types.js';

const clientCache = new Map<string, Client>();
const getClient = (token: string): Client => {
    let client = clientCache.get(token);
    if (!client) {
        // Retries 429/5xx with a delay so the per-company fallback doesn't turn a rate limit into failed rows.
        client = new Client({ accessToken: token, numberOfApiCallRetries: 3 });
        clientCache.set(token, client);
    }
    return client;
};

export class HubspotApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: string,
        path: string,
    ) {
        super(`HubSpot ${status} (${path}): ${body}`);
        this.name = 'HubspotApiError';
    }
}

export class HubspotAuthError extends Error {
    // Set by processCompanyLeads so the caller can persist the company's partial progress.
    partial?: { stats: ContactImportStats; contacts: ContactResult[] };

    constructor(path: string, body: string) {
        super(`HubSpot authentication rejected (401 on ${path}): ${body}`);
        this.name = 'HubspotAuthError';
    }
}

interface SdkHttpError {
    code?: number;
    body?: unknown;
    message?: string;
}

const errorStatus = (err: unknown): number | undefined => {
    const e = err as SdkHttpError | undefined;
    return typeof e?.code === 'number' ? e.code : undefined;
};

const errorBody = (err: unknown): string => {
    const e = err as SdkHttpError | undefined;
    if (e?.body == null) return e?.message ?? '';
    return typeof e.body === 'string' ? e.body : JSON.stringify(e.body);
};

const translateError = (err: unknown, path: string): never => {
    const status = errorStatus(err);
    const body = errorBody(err);
    if (status === 401) throw new HubspotAuthError(path, body);
    throw new HubspotApiError(status ?? 0, body, path);
};

export interface ContactSearchHit {
    id: string;
    properties: Record<string, unknown>;
}

const uniqueProperties = (dedupField: 'email' | 'phone', extra: string[]): string[] => {
    const set = new Set<string>([dedupField, ...extra]);
    return Array.from(set);
};

const searchContactBy = async (
    token: string,
    field: 'email' | 'phone',
    value: string,
    extraProperties: string[],
): Promise<ContactSearchHit | null> => {
    const client = getClient(token);
    try {
        const response = await client.crm.contacts.searchApi.doSearch({
            filterGroups: [{ filters: [{ propertyName: field, operator: 'EQ' as never, value }] }],
            properties: uniqueProperties(field, extraProperties),
            limit: 1,
            after: '0',
            sorts: [],
        });
        const hit = response.results?.[0];
        if (!hit?.id) return null;
        return { id: hit.id, properties: hit.properties ?? {} };
    } catch (err) {
        return translateError(err, '/crm/v3/objects/contacts/search');
    }
};

export const searchContactByEmail = async (
    token: string,
    email: string,
    extraProperties: string[] = [],
): Promise<ContactSearchHit | null> => {
    return searchContactBy(token, 'email', email, extraProperties);
};

export const searchContactByPhone = async (
    token: string,
    phone: string,
    extraProperties: string[] = [],
): Promise<ContactSearchHit | null> => {
    return searchContactBy(token, 'phone', phone, extraProperties);
};

export const createContact = async (
    token: string,
    properties: Record<string, string>,
): Promise<string> => {
    const client = getClient(token);
    try {
        const created = await client.crm.contacts.basicApi.create({ properties, associations: [] });
        if (!created.id) throw new Error('HubSpot createContact returned no id');
        return created.id;
    } catch (err) {
        return translateError(err, '/crm/v3/objects/contacts');
    }
};

export const updateContact = async (
    token: string,
    contactId: string,
    properties: Record<string, string>,
): Promise<void> => {
    const client = getClient(token);
    try {
        await client.crm.contacts.basicApi.update(contactId, { properties });
    } catch (err) {
        translateError(err, `/crm/v3/objects/contacts/${contactId}`);
    }
};

const CONTACT_TO_COMPANY_ASSOCIATION_TYPE_ID = 1;

export const associateContactToCompany = async (
    token: string,
    contactId: string,
    companyId: string,
): Promise<void> => {
    const client = getClient(token);
    const path = `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`;
    try {
        await client.crm.associations.v4.basicApi.create(
            'contacts',
            contactId,
            'companies',
            companyId,
            [{
                associationCategory: 'HUBSPOT_DEFINED' as never,
                associationTypeId: CONTACT_TO_COMPANY_ASSOCIATION_TYPE_ID,
            }],
        );
    } catch (err) {
        if (errorStatus(err) === 409) return;
        translateError(err, path);
    }
};

// --- Company writes (importMode: 'company') ---

export const COMPANY_BATCH_SIZE = 100;

/**
 * Batch-reads the given properties for up to COMPANY_BATCH_SIZE companies.
 * Companies HubSpot can't find are simply absent from the returned map.
 */
export const batchReadCompanies = async (
    token: string,
    companyIds: string[],
    properties: string[],
): Promise<Map<string, Record<string, unknown>>> => {
    const client = getClient(token);
    try {
        const response = await client.crm.companies.batchApi.read({
            inputs: companyIds.map((id) => ({ id })),
            properties,
            propertiesWithHistory: [],
        });
        const out = new Map<string, Record<string, unknown>>();
        for (const result of response.results ?? []) {
            if (result.id) out.set(result.id, result.properties ?? {});
        }
        return out;
    } catch (err) {
        return translateError(err, '/crm/v3/objects/companies/batch/read');
    }
};

/**
 * Batch-updates up to COMPANY_BATCH_SIZE companies. Returns the ids HubSpot
 * reports as updated; callers retry the rest one by one to attribute errors.
 */
export const batchUpdateCompanies = async (
    token: string,
    updates: { id: string; properties: Record<string, string> }[],
): Promise<Set<string>> => {
    const client = getClient(token);
    try {
        const response = await client.crm.companies.batchApi.update({ inputs: updates });
        return new Set((response.results ?? []).map((r) => r.id).filter((id): id is string => Boolean(id)));
    } catch (err) {
        return translateError(err, '/crm/v3/objects/companies/batch/update');
    }
};

export const updateCompany = async (
    token: string,
    companyId: string,
    properties: Record<string, string>,
): Promise<void> => {
    const client = getClient(token);
    try {
        await client.crm.companies.basicApi.update(companyId, { properties });
    } catch (err) {
        translateError(err, `/crm/v3/objects/companies/${companyId}`);
    }
};

const APIFY_PROPERTY_GROUP_NAME = 'apify';

interface ExistingProperty {
    type?: string;
    fieldType?: string;
    calculated?: boolean;
    archived?: boolean;
    modificationMetadata?: { readOnlyValue?: boolean };
}

interface ApifyPropertyDefinition {
    name: string;
    label: string;
    type: string;
    fieldType: string;
    description: string;
}

/**
 * An existing property is only reused when it has the expected `type` and is
 * writable. An incompatible existing property (e.g. a number, a calculated,
 * archived or read-only property) must NOT enable stamping, otherwise the value would be sent
 * inside a contact write that HubSpot would reject, bricking that contact's enrichment.
 */
const isCompatibleProperty = (existing: ExistingProperty, expectedType: string): boolean => (
    existing.type === expectedType
    && !existing.calculated
    && !existing.archived
    && !existing.modificationMetadata?.readOnlyValue
);

const ensureApifyPropertyGroup = async (client: Client): Promise<void> => {
    try {
        await client.crm.properties.groupsApi.create('contacts', {
            name: APIFY_PROPERTY_GROUP_NAME,
            label: 'Apify',
        } as never);
    } catch (err) {
        // 409 = group already exists; 400 = some HubSpot accounts return 400 for duplicates.
        const status = errorStatus(err);
        if (status !== 409 && status !== 400) throw err;
    }
};

const ensureContactProperty = async (
    client: Client,
    definition: ApifyPropertyDefinition,
): Promise<boolean> => {
    try {
        await client.crm.properties.coreApi.create('contacts', {
            ...definition,
            groupName: APIFY_PROPERTY_GROUP_NAME,
        } as never);
        return true;
    } catch (err) {
        if (errorStatus(err) !== 409) throw err;
    }

    // Property already exists (409) — only stamp if it is compatible.
    try {
        const existing = await client.crm.properties.coreApi.getByName('contacts', definition.name) as ExistingProperty;
        if (isCompatibleProperty(existing, definition.type)) return true;
        log.warning(
            `Observability disabled: existing HubSpot property "${definition.name}" `
            + `is not a writable ${definition.type} property `
            + `(type="${existing?.type ?? ''}", calculated=${existing?.calculated ?? false}, `
            + `archived=${existing?.archived ?? false}, `
            + `readOnly=${existing?.modificationMetadata?.readOnlyValue ?? false}). Stamping skipped to avoid breaking contact writes.`
        );
        return false;
    } catch (lookupErr) {
        log.warning(
            `Observability disabled: property "${definition.name}" already exists but could not be read back `
            + `to verify compatibility: ${errorBody(lookupErr)}. Stamping skipped.`
        );
        return false;
    }
};

/**
 * Ensures the "Apify" property group and the given contact property exist.
 * Never throws — any failure disables stamping of that property for the run.
 */
const ensureApifyProperty = async (
    token: string,
    definition: ApifyPropertyDefinition,
): Promise<boolean> => {
    const client = getClient(token);
    try {
        await ensureApifyPropertyGroup(client);
        return await ensureContactProperty(client, definition);
    } catch (err) {
        if (errorStatus(err) === 403) {
            log.warning(
                `Observability disabled: token lacks 'crm.schemas.contacts.write' scope. `
                + `Property "${definition.name}" will not be created or stamped.`
            );
        } else {
            log.warning(
                `Could not ensure observability property "${definition.name}": ${errorBody(err)}`
            );
        }
        return false;
    }
};

/**
 * A HubSpot `datetime` property is created with `fieldType: 'date'`
 * (see HubSpot's type/fieldType table — `datetime` pairs with `date`, not
 * `datetime`). Sending `fieldType: 'datetime'` is rejected by the API and
 * the property is never created, so observability silently never activates.
 */
export const ensureApifyPropertiesExist = async (
    token: string,
    lastEnrichedAtPropertyName: string,
): Promise<boolean> => ensureApifyProperty(token, {
    name: lastEnrichedAtPropertyName,
    label: 'Last enrichment by Apify',
    type: 'datetime',
    fieldType: 'date',
    description: 'Timestamp of the last Apify enrichment run that created or updated this contact.',
});

export const ensureLastEnrichedFieldsProperty = async (
    token: string,
    lastEnrichedFieldsPropertyName: string,
): Promise<boolean> => ensureApifyProperty(token, {
    name: lastEnrichedFieldsPropertyName,
    label: 'Fields updated by Apify',
    type: 'string',
    fieldType: 'textarea',
    description: 'Labels of the contact properties the last Apify enrichment run wrote on create or update.',
});

/**
 * Maps contact property internal names to their labels. Never throws — on
 * failure it returns an empty map and callers fall back to internal names.
 */
export const getContactPropertyLabels = async (token: string): Promise<Record<string, string>> => {
    const client = getClient(token);
    try {
        const response = await client.crm.properties.coreApi.getAll('contacts');
        return Object.fromEntries(
            (response.results ?? [])
                .filter((p) => p.name && p.label)
                .map((p) => [p.name, p.label]),
        );
    } catch (err) {
        log.warning(`Could not read contact property labels, falling back to internal names: ${errorBody(err)}`);
        return {};
    }
};
