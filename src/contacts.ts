import { log } from 'apify';
import type {
    ContactImportStats,
    ContactResult,
    ContactStatus,
    DataMapping,
    LeadsEnrichmentRow,
} from './types.js';
import { filterSkippedProperties, mapItemToProperties } from './utils.js';
import {
    HubspotAuthError,
    associateContactToCompany,
    createContact,
    searchContactByEmail,
    searchContactByPhone,
    updateContact,
} from './api.js';

export type DeduplicationKey = 'email' | 'phone';

export interface ProcessCompanyLeadsResult {
    stats: ContactImportStats;
    contacts: ContactResult[];
}

const buildDisplayName = (lead: LeadsEnrichmentRow): string => {
    const full = lead.fullName?.trim();
    if (full) return full;
    return [lead.firstName, lead.lastName]
        .map((s) => s?.trim())
        .filter((s): s is string => !!s)
        .join(' ');
};

export const processCompanyLeads = async (
    token: string,
    companyId: string,
    leadsEnrichment: LeadsEnrichmentRow[],
    dataMappings: DataMapping[],
    deduplication: DeduplicationKey,
): Promise<ProcessCompanyLeadsResult> => {
    const stats: ContactImportStats = {
        created: 0,
        updated: 0,
        skipped: 0,
        rowsTotal: leadsEnrichment.length,
    };
    const contacts: ContactResult[] = [];

    const recordError = (message: string) => {
        if (!stats.error) stats.error = message;
    };

    const pushResult = (
        lead: LeadsEnrichmentRow,
        status: ContactStatus,
        identifier: string,
        propertiesWritten: string[],
        errorMessage?: string,
    ) => {
        contacts.push({
            kind: 'contact',
            companyId,
            status,
            identifier,
            displayName: buildDisplayName(lead),
            propertiesWritten,
            ...(errorMessage ? { errorMessage } : {}),
        });
    };

    const skipTargets = dataMappings
        .filter((m) => m.overwriteMode === 'skip')
        .map((m) => m.target);

    for (const lead of leadsEnrichment) {
        // Dedup source on the lead: email → lead.email; phone → lead.mobileNumber.
        // HubSpot's contact property is `phone` in both cases, but the scraper emits it as mobileNumber.
        const dedupValue = (deduplication === 'email' ? lead.email : lead.mobileNumber)?.trim();
        if (!dedupValue) {
            stats.skipped++;
            pushResult(lead, 'skipped_no_identifier', '', []);
            continue;
        }

        const properties = mapItemToProperties(lead as Record<string, unknown>, dataMappings);
        if (deduplication === 'email' && !properties.email) properties.email = dedupValue;
        if (deduplication === 'phone' && !properties.phone) properties.phone = dedupValue;

        let contactId: string;
        let writeStatus: 'created' | 'updated' | 'skipped_already_complete';
        let writtenKeys: string[] = [];
        try {
            const existing = deduplication === 'email'
                ? await searchContactByEmail(token, dedupValue, skipTargets)
                : await searchContactByPhone(token, dedupValue, skipTargets);
            if (existing) {
                const filtered = filterSkippedProperties(properties, existing.properties, skipTargets);
                if (Object.keys(filtered).length === 0) {
                    log.info(`Contact ${existing.id}: all mapped fields already populated, skipping update`);
                    stats.skipped++;
                    contactId = existing.id;
                    writeStatus = 'skipped_already_complete';
                } else {
                    await updateContact(token, existing.id, filtered);
                    contactId = existing.id;
                    stats.updated++;
                    writeStatus = 'updated';
                    writtenKeys = Object.keys(filtered);
                }
            } else {
                contactId = await createContact(token, properties);
                stats.created++;
                writeStatus = 'created';
                writtenKeys = Object.keys(properties);
            }
        } catch (err) {
            if (err instanceof HubspotAuthError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Contact write failed for ${dedupValue} (company ${companyId}): ${message}`);
            stats.skipped++;
            recordError(message);
            pushResult(lead, 'failed', dedupValue, [], message);
            continue;
        }

        try {
            await associateContactToCompany(token, contactId, companyId);
            pushResult(lead, writeStatus, dedupValue, writtenKeys);
        } catch (err) {
            if (err instanceof HubspotAuthError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Association failed for contact ${contactId} → company ${companyId}: ${message}`);
            recordError(message);
            // Contact write succeeded but association did not. Surface the association
            // error on the contact's row without flipping its write status.
            pushResult(lead, writeStatus, dedupValue, writtenKeys, `Association failed: ${message}`);
        }
    }

    return { stats, contacts };
};
