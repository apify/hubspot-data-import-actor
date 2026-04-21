import { Actor, log } from 'apify';
import type { ActorOutput, CompanyResult, ContactImportStats, LeadsEnrichmentRow } from './types.js';
import { validateInput } from './validation.js';
import { normalizeUrl } from './utils.js';
import { processCompanyLeads } from './contacts.js';
import { postImportCallback } from './callback.js';
import {
    assertDatasetHasLeads,
    assertSomeCompaniesMatch,
    assertSomeWritesSucceeded,
    deriveCompanyStatus,
} from './failStates.js';

const STATE_KEY = 'MIGRATION_STATE';

interface MigrationState {
    results: CompanyResult[];
    processedIndex: number;
}

const emptyStats = (rowsTotal = 0, error?: string): ContactImportStats => ({
    created: 0,
    updated: 0,
    skipped: 0,
    rowsTotal,
    ...(error ? { error } : {}),
});

await Actor.init();

const startTime = new Date();

try {
    const input = await Actor.getInput();
    const {
        hubspotAccessToken,
        datasetId,
        companyUrlMapping,
        dataMappings,
        runId,
        runSecret,
        callbackUrl,
    } = validateInput(input);

    const cleanedMappings = dataMappings.filter((m) => m.source?.trim() && m.target?.trim());

    // Restore state from previous migration if available
    const store = await Actor.openKeyValueStore();
    const savedState = await store.getValue<MigrationState>(STATE_KEY);
    const results: CompanyResult[] = savedState?.results ?? [];
    let startIndex = savedState?.processedIndex ?? 0;

    if (startIndex > 0) {
        log.info(`Resuming from company index ${startIndex} (${results.length} results from previous run)`);
    }

    Actor.on('migrating', async () => {
        log.info('Migration event received, persisting state...');
        await store.setValue(STATE_KEY, { results, processedIndex: startIndex } satisfies MigrationState);
    });

    log.info(`Starting leads-contact import for ${companyUrlMapping.length} companies from dataset ${datasetId}`);

    log.info('Fetching dataset items...');
    const dataset = await Actor.openDataset(datasetId);
    // Memory: only retain the `leadsEnrichment` arrays keyed by normalized URL.
    // Enrichment dataset items can carry large payloads (SERP results, scraped HTML, etc.)
    // we never use here; dropping them keeps the actor's memory bounded by leads count.
    const leadsByUrl = new Map<string, LeadsEnrichmentRow[]>();
    const PAGE_SIZE = 50;
    let offset = 0;
    let totalItems = 0;

    while (true) {
        const { items } = await dataset.getData({ offset, limit: PAGE_SIZE });
        if (!items || items.length === 0) break;

        for (const item of items) {
            const url = item.originalStartUrl;
            if (typeof url !== 'string' || !url) continue;
            const key = normalizeUrl(url);
            if (leadsByUrl.has(key)) continue;
            const leads = Array.isArray(item.leadsEnrichment)
                ? (item.leadsEnrichment as LeadsEnrichmentRow[])
                : [];
            leadsByUrl.set(key, leads);
        }

        totalItems += items.length;
        offset += items.length;
        if (items.length < PAGE_SIZE) break;
    }

    if (totalItems === 0) {
        throw new Error(`Dataset "${datasetId}" is empty. Please provide a dataset with at least one item.`);
    }

    log.info(`Fetched ${totalItems} items from dataset, mapped ${leadsByUrl.size} unique URLs`);

    assertDatasetHasLeads(datasetId, totalItems, leadsByUrl);
    assertSomeCompaniesMatch(companyUrlMapping, leadsByUrl);

    const unmatchedCompanies: string[] = [];

    for (let i = startIndex; i < companyUrlMapping.length; i++) {
        const { url: companyUrl, companyId } = companyUrlMapping[i];

        let stats: ContactImportStats;
        let status: CompanyResult['status'] = 'imported';

        if (!companyUrl?.trim()) {
            log.info(`Skipping company ${companyId}: no company URL provided`);
            stats = emptyStats(0, 'No company URL provided');
            status = 'skipped';
        } else {
            const normalizedCompanyUrl = normalizeUrl(companyUrl);
            const leads = leadsByUrl.get(normalizedCompanyUrl);

            if (!leads) {
                log.warning(`No dataset item found for company ${companyId} (URL: ${companyUrl})`);
                unmatchedCompanies.push(companyUrl);
                stats = emptyStats(0, 'No matching dataset item found');
                status = 'failed';
            } else {
                if (leads.length === 0) {
                    log.info(`Company ${companyId}: matched item has no leadsEnrichment rows`);
                    stats = emptyStats(0);
                    status = 'imported';
                } else {
                    log.info(`Processing ${leads.length} lead rows for company ${companyId}...`);
                    stats = await processCompanyLeads(hubspotAccessToken, companyId, leads, cleanedMappings);
                    status = deriveCompanyStatus(stats);
                }
            }
        }

        results.push({ companyId, companyUrl: companyUrl ?? '', status, ...stats });

        await postImportCallback(callbackUrl, runId, runSecret, companyId, stats);

        startIndex = i + 1;
    }

    const endTime = new Date();
    const duration = (endTime.getTime() - startTime.getTime()) / 1000;

    const totalCreated = results.reduce((sum, r) => sum + r.created, 0);
    const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
    const totalRows = results.reduce((sum, r) => sum + r.rowsTotal, 0);

    const anyCompanyHadError = results.some((r) => r.error != null);
    assertSomeWritesSucceeded({ totalCreated, totalUpdated, anyCompanyHadError });

    const output: ActorOutput = {
        totalCompanies: companyUrlMapping.length,
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalRows,
        unmatchedCompanies,
        results,
        datasetId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
    };

    await Actor.pushData(results);
    await Actor.setValue('OUTPUT', output);

    await store.setValue(STATE_KEY, null);

    log.info('Leads-contact import complete!', {
        totalCompanies: companyUrlMapping.length,
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalRows,
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
