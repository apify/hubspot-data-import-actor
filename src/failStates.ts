import type { CompanyUrlMapping, ContactImportStats, LeadsEnrichmentRow } from './types.js';
import { normalizeUrl } from './utils.js';

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

export const assertVerificationDataPresent = (
    onlyVerifiedEmails: boolean,
    leadsByUrl: Map<string, LeadsEnrichmentRow[]>,
): void => {
    if (!onlyVerifiedEmails) return;
    let anyEmail = false;
    for (const leads of leadsByUrl.values()) {
        if (leads.some((l) => l.emailVerification)) return;
        if (leads.some((l) => l.email?.trim())) anyEmail = true;
    }
    // No emails at all means nothing to verify — a no-results run, not a misconfiguration.
    if (!anyEmail) return;
    throw new Error(
        'onlyVerifiedEmails is enabled but no lead in the dataset carries an emailVerification block. '
        + 'The enrichment run was likely produced with email verification disabled '
        + '(verifyLeadsEnrichmentEmails) or by an older actor build. '
        + 'Nothing would be imported.',
    );
};

export const assertSomeWritesSucceeded = (totals: {
    totalCreated: number;
    totalUpdated: number;
    totalFailed: number;
    anyCompanyHadError: boolean;
}): void => {
    const zeroWrites = totals.totalCreated + totals.totalUpdated === 0;
    if (zeroWrites && (totals.anyCompanyHadError || totals.totalFailed > 0)) {
        throw new Error(
            `All lead writes failed. 0 created, 0 updated, ${totals.totalFailed} failed across all companies. `
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
