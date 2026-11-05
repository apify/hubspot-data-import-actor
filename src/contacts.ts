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

export interface ContactObservability {
    lastEnrichedAtPropertyName?: string;
    lastEnrichedFields?: {
        propertyName: string;
        /** Property internal name → label; names missing here are listed as-is. */
        labels: Record<string, string>;
    };
}

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

// Adds the observability stamps to the properties of a contact write. The fields
// list is built before stamping, so it never names the Apify properties themselves.
const withObservabilityStamps = (
    properties: Record<string, string>,
    observability: ContactObservability,
): Record<string, string> => {
    const stamped = { ...properties };
    if (observability.lastEnrichedFields) {
        const { propertyName, labels } = observability.lastEnrichedFields;
        stamped[propertyName] = Object.keys(properties).map((name) => labels[name] ?? name).join(', ');
    }
    if (observability.lastEnrichedAtPropertyName) {
        stamped[observability.lastEnrichedAtPropertyName] = new Date().toISOString();
    }
    return stamped;
};

export const processCompanyLeads = async (
    token: string,
    companyId: string,
    leadsEnrichment: LeadsEnrichmentRow[],
    dataMappings: DataMapping[],
    deduplication: DeduplicationKey,
    observability: ContactObservability = {},
    onlyVerifiedEmails = false,
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

    if (onlyVerifiedEmails && leadsEnrichment.length > 0 && !leadsEnrichment.some((l) => l.emailVerification)) {
        log.warning(`Company ${companyId}: onlyVerifiedEmails is enabled but no lead carries an email verification object — all leads will be skipped. The enrichment run may have had email verification disabled.`);
    }

    for (const lead of leadsEnrichment) {
        if (onlyVerifiedEmails && lead.emailVerification?.result !== 'ok') {
            stats.skipped++;
            pushResult(lead, 'skipped_unverified_email', '', []);
            continue;
        }

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
                    const payload = withObservabilityStamps(filtered, observability);
                    await updateContact(token, existing.id, payload);
                    contactId = existing.id;
                    stats.updated++;
                    writeStatus = 'updated';
                    writtenKeys = Object.keys(payload);
                }
            } else {
                const payload = withObservabilityStamps(properties, observability);
                contactId = await createContact(token, payload);
                stats.created++;
                writeStatus = 'created';
                writtenKeys = Object.keys(payload);
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
