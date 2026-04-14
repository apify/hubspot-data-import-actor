import { Client } from '@hubspot/api-client';

export const createHubspotClient = (accessToken: string): Client => {
    return new Client({ accessToken });
};

/**
 * Updates a HubSpot company with the provided properties.
 */
export const updateCompany = async (
    client: Client,
    companyId: string,
    properties: Record<string, string>,
): Promise<void> => {
    await client.crm.companies.basicApi.update(companyId, { properties });
};
