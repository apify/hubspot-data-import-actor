import { Client } from '@hubspot/api-client';

const clientCache = new Map<string, Client>();
const getClient = (token: string): Client => {
    let client = clientCache.get(token);
    if (!client) {
        client = new Client({ accessToken: token });
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
