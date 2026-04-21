const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

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

interface HubspotFetchOptions {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
}

const hubspotFetch = async <T>(
    token: string,
    path: string,
    { method, body }: HubspotFetchOptions,
): Promise<{ status: number; data: T | null }> => {
    const response = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) {
        return { status: response.status, data: null };
    }

    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : null;

    if (!response.ok) {
        if (response.status === 401) throw new HubspotAuthError(path, text);
        throw new HubspotApiError(response.status, text, path);
    }

    return { status: response.status, data };
};

interface ContactSearchResponse {
    results?: Array<{ id: string }>;
}

export const searchContactByEmail = async (
    token: string,
    email: string,
): Promise<string | null> => {
    const { data } = await hubspotFetch<ContactSearchResponse>(token, '/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
            limit: 1,
            properties: ['email'],
        },
    });
    return data?.results?.[0]?.id ?? null;
};

interface ContactMutationResponse {
    id: string;
}

export const createContact = async (
    token: string,
    properties: Record<string, string>,
): Promise<string> => {
    const { data } = await hubspotFetch<ContactMutationResponse>(token, '/crm/v3/objects/contacts', {
        method: 'POST',
        body: { properties },
    });
    if (!data?.id) throw new Error('HubSpot createContact returned no id');
    return data.id;
};

export const updateContact = async (
    token: string,
    contactId: string,
    properties: Record<string, string>,
): Promise<void> => {
    await hubspotFetch(token, `/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        body: { properties },
    });
};

/**
 * Associates a contact to a company. Treats 2xx and 409 (already associated) as success.
 */
export const associateContactToCompany = async (
    token: string,
    contactId: string,
    companyId: string,
): Promise<void> => {
    try {
        await hubspotFetch(
            token,
            `/crm/v3/objects/contacts/${contactId}/associations/companies/${companyId}/contact_to_company`,
            { method: 'PUT' },
        );
    } catch (err) {
        if (err instanceof HubspotApiError && err.status === 409) return;
        throw err;
    }
};
