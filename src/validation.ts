import type { ActorInput } from './types.js';

/**
 * Validates the actor input configuration.
 * Throws descriptive errors if any required fields are missing or invalid.
 */
export const validateInput = (input: ActorInput): void => {
    if (!input.hubspotApiKey) {
        throw new Error('Missing required input "hubspotApiKey". Please provide your HubSpot private app API key.');
    }
    if (!input.datasetId) {
        throw new Error('Missing required input "datasetId". Please select an Apify dataset to import from.');
    }
    if (!input.companyId || !input.companyId.trim()) {
        throw new Error('Missing required input "companyId". Please provide a HubSpot company ID to update.');
    }

    const cleanedMappings = input.dataMappings?.filter(
        (m) => m.source?.trim() && m.target?.trim(),
    );
    if (!Array.isArray(cleanedMappings) || cleanedMappings.length === 0) {
        throw new Error(
            'Input "dataMappings" must be a non-empty array with at least one valid mapping. '
            + 'Each mapping must have non-empty "source" and "target" fields.',
        );
    }
};
