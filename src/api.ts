import { Client } from '@hubspot/api-client';

/**
 * Updates a HubSpot company with the provided properties.
 */
export const updateCompany = async (
    accessToken: string,
    companyId: string,
    properties: Record<string, string>,
): Promise<void> => {
    const client = new Client({ accessToken });
    await client.crm.companies.basicApi.update(companyId, { properties });
};
