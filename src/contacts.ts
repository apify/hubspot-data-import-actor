import { log } from 'apify';
import type { ContactImportStats, DataMapping, LeadsEnrichmentRow } from './types.js';
import { mapItemToProperties } from './utils.js';
import {
    HubspotAuthError,
    associateContactToCompany,
    createContact,
    searchContactByEmail,
    searchContactByPhone,
    updateContact,
} from './api.js';

export type DeduplicationKey = 'email' | 'phone';

export const processCompanyLeads = async (
    token: string,
    companyId: string,
    leadsEnrichment: LeadsEnrichmentRow[],
    dataMappings: DataMapping[],
    deduplication: DeduplicationKey,
): Promise<ContactImportStats> => {
    const stats: ContactImportStats = {
        created: 0,
        updated: 0,
        skipped: 0,
        rowsTotal: leadsEnrichment.length,
    };

    const recordError = (message: string) => {
        if (!stats.error) stats.error = message;
    };

    for (const lead of leadsEnrichment) {
        // Dedup source on the lead: email → lead.email; phone → lead.mobileNumber.
        // HubSpot's contact property is `phone` in both cases, but the scraper emits it as mobileNumber.
        const dedupValue = (deduplication === 'email' ? lead.email : lead.mobileNumber)?.trim();
        if (!dedupValue) {
            stats.skipped++;
            continue;
        }

        const properties = mapItemToProperties(lead as Record<string, unknown>, dataMappings);
        if (deduplication === 'email' && !properties.email) properties.email = dedupValue;
        if (deduplication === 'phone' && !properties.phone) properties.phone = dedupValue;

        let contactId: string;
        try {
            const existingId = deduplication === 'email'
                ? await searchContactByEmail(token, dedupValue)
                : await searchContactByPhone(token, dedupValue);
            if (existingId) {
                await updateContact(token, existingId, properties);
                contactId = existingId;
                stats.updated++;
            } else {
                contactId = await createContact(token, properties);
                stats.created++;
            }
        } catch (err) {
            if (err instanceof HubspotAuthError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Contact write failed for ${dedupValue} (company ${companyId}): ${message}`);
            stats.skipped++;
            recordError(message);
            continue;
        }

        try {
            await associateContactToCompany(token, contactId, companyId);
        } catch (err) {
            if (err instanceof HubspotAuthError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Association failed for contact ${contactId} → company ${companyId}: ${message}`);
            recordError(message);
        }
    }

    return stats;
};
