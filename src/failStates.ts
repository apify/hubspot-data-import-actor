import type { CompanyUrlMapping, ContactImportStats, LeadsEnrichmentRow } from './types.js';
import { normalizeUrl } from './utils.js';

export const assertDatasetHasLeads = (
    datasetId: string,
    totalItems: number,
    leadsByUrl: Map<string, LeadsEnrichmentRow[]>,
): void => {
    let totalLeadRows = 0;
    for (const leads of leadsByUrl.values()) totalLeadRows += leads.length;
    if (totalLeadRows === 0) {
        throw new Error(
            `Dataset "${datasetId}" has ${totalItems} item(s) but no leadsEnrichment rows. Nothing to import.`,
        );
    }
};

export const assertSomeCompaniesMatch = (
    companyUrlMapping: CompanyUrlMapping[],
    leadsByUrl: Map<string, LeadsEnrichmentRow[]>,
): void => {
    const matchedCount = companyUrlMapping.filter(
        ({ url }) => url?.trim() && leadsByUrl.has(normalizeUrl(url)),
    ).length;
    if (matchedCount === 0) {
        throw new Error(
            `None of the ${companyUrlMapping.length} company URL(s) matched any dataset item. `
            + `Check that the enrichment actor's originalStartUrl matches the config company domains.`,
        );
    }
};

export const assertSomeWritesSucceeded = (totals: {
    totalCreated: number;
    totalUpdated: number;
    anyCompanyHadError: boolean;
}): void => {
    const zeroWrites = totals.totalCreated + totals.totalUpdated === 0;
    if (zeroWrites && totals.anyCompanyHadError) {
        throw new Error(
            'All lead writes failed. 0 created, 0 updated across all companies. '
            + 'See per-company errors in dataset.',
        );
    }
};

export const deriveCompanyStatus = (stats: ContactImportStats): 'imported' | 'failed' => {
    const allFailed = stats.rowsTotal > 0
        && stats.created === 0
        && stats.updated === 0
        && stats.error != null;
    return allFailed ? 'failed' : 'imported';
};
