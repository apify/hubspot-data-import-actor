import { log } from 'apify';
import type { ContactImportStats, DataMapping, LeadsEnrichmentRow } from './types.js';
import { mapItemToProperties } from './utils.js';
import {
    associateContactToCompany,
    createContact,
    searchContactByEmail,
    updateContact,
} from './api.js';

export const processCompanyLeads = async (
    token: string,
    companyId: string,
    leadsEnrichment: LeadsEnrichmentRow[],
    dataMappings: DataMapping[],
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
        const email = lead.email?.trim();
        if (!email) {
            stats.skipped++;
            continue;
        }

        const properties = mapItemToProperties(lead as Record<string, unknown>, dataMappings);
        if (!properties.email) properties.email = email;

        let contactId: string;
        try {
            const existingId = await searchContactByEmail(token, email);
            if (existingId) {
                await updateContact(token, existingId, properties);
                contactId = existingId;
                stats.updated++;
            } else {
                contactId = await createContact(token, properties);
                stats.created++;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Contact write failed for ${email} (company ${companyId}): ${message}`);
            stats.skipped++;
            recordError(message);
            continue;
        }

        try {
            await associateContactToCompany(token, contactId, companyId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Association failed for contact ${contactId} → company ${companyId}: ${message}`);
            recordError(message);
        }
    }

    return stats;
};
