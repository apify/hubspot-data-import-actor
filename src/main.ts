import { Actor, log } from 'apify';
import type { ActorOutput, CompanyResult } from './types.js';
import { validateInput } from './validation.js';
import { mapItemToProperties, normalizeUrl } from './utils.js';
import { createHubspotClient, updateCompany } from './api.js';

const STATE_KEY = 'MIGRATION_STATE';

interface MigrationState {
    results: CompanyResult[];
    processedIndex: number;
}

await Actor.init();

const startTime = new Date();

try {
    const input = await Actor.getInput();
    const { hubspotAccessToken, datasetId, companyUrlMapping, dataMappings } = validateInput(input);

    const hubspotClient = createHubspotClient(hubspotAccessToken);
    const cleanedMappings = dataMappings.filter((m) => m.source?.trim() && m.target?.trim());

    // Restore state from previous migration if available
    const store = await Actor.openKeyValueStore();
    const savedState = await store.getValue<MigrationState>(STATE_KEY);
    const results: CompanyResult[] = savedState?.results ?? [];
    let startIndex = savedState?.processedIndex ?? 0;

    if (startIndex > 0) {
        log.info(`Resuming from company index ${startIndex} (${results.length} results from previous run)`);
    }

    // Persist state on migration
    Actor.on('migrating', async () => {
        log.info('Migration event received, persisting state...');
        await store.setValue(STATE_KEY, { results, processedIndex: startIndex } satisfies MigrationState);
    });

    log.info(`Starting multi-company import for ${companyUrlMapping.length} companies from dataset ${datasetId}`);

    log.info('Fetching dataset items...');
    const dataset = await Actor.openDataset(datasetId);
    const itemsByUrl = new Map<string, Record<string, unknown>>();
    const PAGE_SIZE = 50;
    let offset = 0;
    let totalItems = 0;

    while (true) {
        const { items } = await dataset.getData({ offset, limit: PAGE_SIZE });
        if (!items || items.length === 0) break;

        for (const item of items) {
            const url = item.originalStartUrl;
            if (typeof url === 'string' && url) {
                const key = normalizeUrl(url);
                if (!itemsByUrl.has(key)) {
                    itemsByUrl.set(key, item);
                }
            }
        }

        totalItems += items.length;
        offset += items.length;
        if (items.length < PAGE_SIZE) break;
    }

    if (totalItems === 0) {
        throw new Error(`Dataset "${datasetId}" is empty. Please provide a dataset with at least one item.`);
    }

    log.info(`Fetched ${totalItems} items from dataset, mapped ${itemsByUrl.size} unique URLs`);

    log.info('Processing companies...');
    const unmatchedCompanies: string[] = [];

    for (let i = startIndex; i < companyUrlMapping.length; i++) {
        const { url: companyUrl, companyId } = companyUrlMapping[i];

        if (!companyUrl?.trim()) {
            log.info(`Skipping company ${companyId}: no company URL provided`);
            results.push({ companyId, companyUrl: '', status: 'skipped', success: false, propertiesUpdated: 0, skipReason: 'No company URL provided' });
            startIndex = i + 1;
            continue;
        }

        const normalizedCompanyUrl = normalizeUrl(companyUrl);
        const matchingItem = itemsByUrl.get(normalizedCompanyUrl);

        if (!matchingItem) {
            log.warning(`No dataset item found for company ${companyId} (URL: ${companyUrl})`);
            unmatchedCompanies.push(companyUrl);
            results.push({ companyId, companyUrl, status: 'failed', success: false, propertiesUpdated: 0, error: 'No matching dataset item found' });
            startIndex = i + 1;
            continue;
        }

        try {
            const properties = mapItemToProperties(matchingItem, cleanedMappings);

            if (Object.keys(properties).length === 0) {
                log.warning(`No properties mapped for company ${companyId} (URL: ${companyUrl})`);
                results.push({ companyId, companyUrl, status: 'failed', success: false, propertiesUpdated: 0, error: 'No properties could be mapped from the dataset item' });
                startIndex = i + 1;
                continue;
            }

            log.info(`Updating company ${companyId} with ${Object.keys(properties).length} properties...`);
            await updateCompany(hubspotClient, companyId, properties);

            log.info(`Successfully updated company ${companyId}`);
            results.push({ companyId, companyUrl, status: 'imported', success: true, propertiesUpdated: Object.keys(properties).length });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Failed to update company ${companyId}: ${errorMessage}`);
            results.push({ companyId, companyUrl, status: 'failed', success: false, propertiesUpdated: 0, error: errorMessage });
        }

        startIndex = i + 1;
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

    // Clean up migration state on successful completion
    await store.setValue(STATE_KEY, null);

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
