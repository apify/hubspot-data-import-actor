import { log } from 'apify';
import type {
    ContactImportStats,
    ContactResult,
    ContactStatus,
    DataMapping,
    LeadsEnrichmentRow,
} from './types.js';
import { RESULT_VERSION_2 } from './types.js';
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

/** Terminal reason when a company's processing stopped early. */
export type CompanyStopReason = 'auth_failed' | 'unexpected_error' | 'progress_persist_failed' | 'complete';

/**
 * Progress checkpoint handed to the sink after every COMPLETED contact
 * (write confirmed + row emitted). The caller persists it (state + dataset
 * publication) so an interruption never loses confirmed counts.
 */
export interface ContactProgress {
    leadIndex: number;
    stats: ContactImportStats;
    contact: ContactResult;
}

export interface ProcessCompanyLeadsResult {
    stats: ContactImportStats;
    contacts: ContactResult[];
    processingComplete: boolean;
    stopReason: CompanyStopReason;
}

export type ContactProgressSink = (progress: ContactProgress) => Promise<void>;

const buildDisplayName = (lead: LeadsEnrichmentRow): string => {
    const full = lead.fullName?.trim();
    if (full) return full;
    return [lead.firstName, lead.lastName]
        .map((s) => s?.trim())
        .filter((s): s is string => !!s)
        .join(' ');
};

/**
 * Process one company's valid lead rows into HubSpot contacts.
 *
 * v2 accounting:
 *   - `skipped` counts INTENTIONAL skips only (verification filter, missing
 *     dedup identifier, every mapped field already populated);
 *   - failed lookups/creates/updates count `failed` and keep processing
 *     (per-contact API failures are recoverable);
 *   - a 401 (`HubspotAuthError`) STOPS processing with the confirmed counts
 *     and rows preserved (`processingComplete: false`) — every later lead
 *     would fail identically, and the caller persists an explicit INCOMPLETE
 *     company row instead of replaying the company;
 *   - a sink (progress persistence) failure also stops processing — no
 *     further CRM writes happen with unpersisted progress;
 *   - an association failure after a confirmed write keeps the write counted
 *     and surfaces the association error on the contact's row (association
 *     edge cases remain deferred by the agreed scope).
 */
export const processCompanyLeads = async (
    token: string,
    companyId: string,
    companyIndex: number,
    leadsEnrichment: LeadsEnrichmentRow[],
    dataMappings: DataMapping[],
    deduplication: DeduplicationKey,
    onlyVerifiedEmails = false,
    sink?: ContactProgressSink,
): Promise<ProcessCompanyLeadsResult> => {
    const stats: ContactImportStats = {
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        rowsTotal: leadsEnrichment.length,
    };
    const contacts: ContactResult[] = [];

    const recordError = (message: string) => {
        if (!stats.error) stats.error = message;
    };

    let stopReason: CompanyStopReason | undefined;

    const emit = (
        leadIndex: number,
        lead: LeadsEnrichmentRow,
        status: ContactStatus,
        identifier: string,
        propertiesWritten: string[],
        errorMessage?: string,
    ): ContactResult => {
        const contact: ContactResult = {
            kind: 'contact',
            resultVersion: RESULT_VERSION_2,
            resultId: `contact:${companyId}:${companyIndex}:${leadIndex}`,
            sourceIndex: leadIndex,
            companyId,
            status,
            identifier,
            displayName: buildDisplayName(lead),
            propertiesWritten,
            ...(errorMessage ? { errorMessage } : {}),
        };
        contacts.push(contact);
        return contact;
    };

    /**
     * Persist one completed contact through the sink: state checkpoint FIRST
     * (so a crash after the write but before publication still leaves the
     * count), then dataset publication (stable resultId makes a repeated
     * publication deduplicable). A sink failure stops further CRM writes.
     */
    const persist = async (leadIndex: number, contact: ContactResult): Promise<void> => {
        if (!sink) return;
        try {
            await sink({ leadIndex, stats: { ...stats }, contact });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warning(`Progress persistence failed for company ${companyId}, lead ${leadIndex}: ${message} — stopping further CRM writes.`);
            recordError(`Progress persistence failed: ${message}`);
            if (!stopReason) stopReason = 'progress_persist_failed';
        }
    };

    const skipTargets = dataMappings
        .filter((m) => m.overwriteMode === 'skip')
        .map((m) => m.target);

    for (const [leadIndex, lead] of leadsEnrichment.entries()) {
        if (stopReason) break;

        // --- Intentional skip: verification filter ---------------------------
        if (onlyVerifiedEmails && lead.emailVerification?.result !== 'ok') {
            stats.skipped += 1;
            await persist(leadIndex, emit(leadIndex, lead, 'skipped_unverified_email', '', []));
            continue;
        }

        // --- Intentional skip: no dedup identifier ---------------------------
        // HubSpot's contact property is `phone` in both cases, but the
        // scraper emits the dedup phone value as `mobileNumber`.
        const dedupValue = (deduplication === 'email' ? lead.email : lead.mobileNumber)?.trim();
        if (!dedupValue) {
            stats.skipped += 1;
            await persist(leadIndex, emit(leadIndex, lead, 'skipped_no_identifier', '', []));
            continue;
        }

        const properties = mapItemToProperties(lead as Record<string, unknown>, dataMappings);
        if (deduplication === 'email' && !properties.email) properties.email = dedupValue;
        if (deduplication === 'phone' && !properties.phone) properties.phone = dedupValue;

        // --- Lookup + write (may fail per-contact) ---------------------------
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
                    stats.skipped += 1;
                    writeStatus = 'skipped_already_complete';
                    contactId = existing.id;
                } else {
                    await updateContact(token, existing.id, filtered);
                    stats.updated += 1; // confirmed by the successful response
                    writeStatus = 'updated';
                    contactId = existing.id;
                    writtenKeys = Object.keys(filtered);
                }
            } else {
                contactId = await createContact(token, properties);
                stats.created += 1; // confirmed by the successful response
                writeStatus = 'created';
                writtenKeys = Object.keys(properties);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            if (err instanceof HubspotAuthError) {
                // Portal-wide auth failure: this lead's op failed, count it,
                // then STOP — every later lead would fail identically.
                stats.failed += 1;
                recordError(message);
                await persist(leadIndex, emit(leadIndex, lead, 'failed', dedupValue, [], message));
                stopReason = 'auth_failed';
                break;
            }

            if (!(err instanceof Error)) {
                // A non-Error throwable is a bug, not an API state — stop
                // rather than repeat it on every remaining lead.
                stats.failed += 1;
                recordError(message);
                await persist(leadIndex, emit(leadIndex, lead, 'failed', dedupValue, [], message));
                stopReason = 'unexpected_error';
                break;
            }

            // Ordinary per-contact API failure: count, surface, continue.
            log.warning(`Contact write failed for ${dedupValue} (company ${companyId}): ${message}`);
            stats.failed += 1;
            recordError(message);
            await persist(leadIndex, emit(leadIndex, lead, 'failed', dedupValue, [], message));
            continue;
        }

        // --- Association (write already confirmed) --------------------------
        // Even `skipped_already_complete` contacts are associated (v1
        // behavior). An association failure keeps the confirmed write count
        // and is surfaced on the contact's row.
        try {
            await associateContactToCompany(token, contactId, companyId);
            await persist(leadIndex, emit(leadIndex, lead, writeStatus, dedupValue, writtenKeys));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            recordError(`Association failed: ${message}`);
            const contact = emit(leadIndex, lead, writeStatus, dedupValue, writtenKeys, `Association failed: ${message}`);
            if (err instanceof HubspotAuthError) {
                stopReason = 'auth_failed';
                break;
            }
            await persist(leadIndex, contact);
        }
    }

    return {
        stats,
        contacts,
        processingComplete: stopReason === undefined,
        stopReason: stopReason ?? 'complete',
    };
};