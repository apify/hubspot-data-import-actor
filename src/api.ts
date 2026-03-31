import { log } from 'apify';
import { HUBSPOT_API_BASE_URL } from './constants.js';
import { HubSpotCompanyResponseSchema, validateResponse } from './schemas.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch wrapper with minimal exponential backoff retry logic.
 * Retries on rate limits (429) and server errors (5xx).
 */
export const fetchWithRetry = async (url: string, options: RequestInit, maxRetries = 3): Promise<Response> => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);

            // Return immediately on success or client errors (except 429)
            if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
                return response;
            }

            // Throw on retryable status codes (429, 5xx) so retry is handled once in catch
            throw new Error(`Request failed with status ${response.status}`);
        } catch (error: any) {
            lastError = error;
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warning(
                    `${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`,
                );
                await sleep(delay);
            }
        }
    }

    throw lastError || new Error('Max retries exceeded');
};

/**
 * Verifies the HubSpot access token is valid and the company exists.
 * Makes a GET request to fetch the company by ID.
 */
export const verifyCompany = async (apiKey: string, companyId: string): Promise<void> => {
    const url = `${HUBSPOT_API_BASE_URL}/crm/v3/objects/companies/${companyId}`;
    const response = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Failed to verify company "${companyId}" (${response.status} ${response.statusText}): ${errorText}. `
            + 'Please check your HubSpot access token and company ID.',
        );
    }

    const rawData = await response.json();
    validateResponse(HubSpotCompanyResponseSchema, rawData, 'company verification');
};

/**
 * Updates a HubSpot company with the provided properties.
 * Uses PATCH /crm/v3/objects/companies/{companyId}.
 */
export const updateCompany = async (
    apiKey: string,
    companyId: string,
    properties: Record<string, string>,
): Promise<void> => {
    const url = `${HUBSPOT_API_BASE_URL}/crm/v3/objects/companies/${companyId}`;
    const response = await fetchWithRetry(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Failed to update company "${companyId}" (${response.status} ${response.statusText}): ${errorText}`,
        );
    }

    const rawData = await response.json();
    validateResponse(HubSpotCompanyResponseSchema, rawData, 'company update');
};
