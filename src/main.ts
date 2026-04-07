import { Actor, log } from 'apify';
import type { ActorInput, ActorOutput, CompanyResult } from './types.js';
import { validateInput } from './validation.js';
import { mapItemToProperties, normalizeUrl, buildItemsByUrl } from './utils.js';
import { updateCompany } from './api.js';

await Actor.init();

const startTime = new Date();

try {
    const input = (await Actor.getInput()) as ActorInput | null;

    if (!input) {
        throw new Error('No input provided');
    }

    validateInput(input);

    const { hubspotAccessToken, datasetId, companyUrlMapping, dataMappings } = input;

    const cleanedMappings = dataMappings.filter((m) => m.source?.trim() && m.target?.trim());

    log.info(`Starting multi-company import for ${companyUrlMapping.length} companies from dataset ${datasetId}`);

    log.info('Step 1: Fetching all dataset items...');
    const dataset = await Actor.openDataset(datasetId);
    const { items } = await dataset.getData({ offset: 0, limit: 10000 });

    if (!items || items.length === 0) {
        throw new Error(`Dataset "${datasetId}" is empty. Please provide a dataset with at least one item.`);
    }

    log.info(`Fetched ${items.length} items from dataset`);

    log.info('Step 2: Building URL lookup map...');
    const itemsByUrl = buildItemsByUrl(items);
    log.info(`Mapped ${itemsByUrl.size} unique URLs from dataset items`);

    log.info('Step 3: Processing companies...');
    const results: CompanyResult[] = [];
    const unmatchedCompanies: string[] = [];

    for (const { url: companyUrl, companyId } of companyUrlMapping) {
        if (!companyUrl?.trim()) {
            log.info(`Skipping company ${companyId}: no company URL provided`);
            results.push({ companyId, companyUrl: '', status: 'skipped', success: false, propertiesUpdated: 0, skipReason: 'No company URL provided' });
            continue;
        }

        const normalizedCompanyUrl = normalizeUrl(companyUrl);
        const matchingItem = itemsByUrl.get(normalizedCompanyUrl);

        if (!matchingItem) {
            log.warning(`No dataset item found for company ${companyId} (URL: ${companyUrl})`);
            unmatchedCompanies.push(companyUrl);
            results.push({ companyId, companyUrl, status: 'failed', success: false, propertiesUpdated: 0, error: 'No matching dataset item found' });
            continue;
        }

        try {
            const properties = mapItemToProperties(matchingItem, cleanedMappings);

            if (Object.keys(properties).length === 0) {
                log.warning(`No properties mapped for company ${companyId} (URL: ${companyUrl})`);
                results.push({ companyId, companyUrl, status: 'failed', success: false, propertiesUpdated: 0, error: 'No properties could be mapped from the dataset item' });
                continue;
            }

            log.info(`Updating company ${companyId} with ${Object.keys(properties).length} properties...`);
            await updateCompany(hubspotAccessToken, companyId, properties);

            log.info(`Successfully updated company ${companyId}`);
            results.push({ companyId, companyUrl, status: 'imported', success: true, propertiesUpdated: Object.keys(properties).length });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Failed to update company ${companyId}: ${errorMessage}`);
            results.push({ companyId, companyUrl, status: 'failed', success: false, propertiesUpdated: 0, error: errorMessage });
        }
    }

    const endTime = new Date();
    const duration = (endTime.getTime() - startTime.getTime()) / 1000;

    const successCount = results.filter((r) => r.status === 'imported').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    const failureCount = results.filter((r) => r.status === 'failed').length;

    const output: ActorOutput = {
        totalCompanies: companyUrlMapping.length,
        successCount,
        skippedCount,
        failureCount,
        unmatchedCompanies,
        results,
        datasetId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
    };

    await Actor.pushData(output);

    log.info('Import complete!', {
        totalCompanies: companyUrlMapping.length,
        successCount,
        failureCount,
        unmatchedCount: unmatchedCompanies.length,
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
