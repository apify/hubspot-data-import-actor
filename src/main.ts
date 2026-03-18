import { Actor, log } from 'apify';
import type { ActorInput, ActorOutput } from './types.js';
import { validateInput } from './validation.js';
import { mapItemToProperties } from './utils.js';
import { verifyCompany, updateCompany } from './api.js';

await Actor.init();

const startTime = new Date();

try {
    const input = (await Actor.getInput()) as ActorInput | null;

    if (!input) {
        throw new Error('No input provided');
    }

    validateInput(input);

    const { hubspotAccessToken, datasetId, companyId, dataMappings } = input;

    const cleanedMappings = dataMappings.filter((m) => m.source?.trim() && m.target?.trim());

    log.info(`Starting import to HubSpot company ${companyId}`);

    log.info('Step 1: Verifying HubSpot access token and company...');
    await verifyCompany(hubspotAccessToken, companyId);
    log.info(`Verified company ${companyId} exists`);

    log.info('Step 2: Fetching first dataset item...');
    const dataset = await Actor.openDataset(datasetId);
    const { items } = await dataset.getData({ offset: 0, limit: 1 });

    if (!items || items.length === 0) {
        throw new Error(`Dataset "${datasetId}" is empty. Please provide a dataset with at least one item.`);
    }

    const firstItem = items[0];

    log.info('Step 3: Mapping fields...');
    const properties = mapItemToProperties(firstItem, cleanedMappings);

    if (Object.keys(properties).length === 0) {
        throw new Error(
            'No properties could be mapped from the dataset item. '
            + 'Please verify your field mappings match the dataset structure.',
        );
    }

    log.info(`Mapped ${Object.keys(properties).length} properties: ${Object.keys(properties).join(', ')}`);

    log.info('Step 4: Updating company in HubSpot...');
    await updateCompany(hubspotAccessToken, companyId, properties);
    log.info('Company updated successfully');

    const endTime = new Date();
    const duration = (endTime.getTime() - startTime.getTime()) / 1000;

    const output: ActorOutput = {
        success: true,
        companyId,
        datasetId,
        propertiesUpdated: Object.keys(properties).length,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
    };

    await Actor.pushData(output);

    log.info('Import complete!', {
        companyId,
        propertiesUpdated: Object.keys(properties).length,
        duration,
    });
} catch (err) {
    log.error('Import failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    await Actor.fail(errorMessage);
} finally {
    await Actor.exit();
}
