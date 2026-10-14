/**
 * Source-dataset reading and per-company source classification.
 *
 * Extracted from the old inline dataset loop so evidence survives beyond the
 * in-memory lead map: for each normalized URL we keep WHAT the matched items
 * carried (leads field present? rows valid or malformed? read complete?) —
 * the difference between a VALID empty enrichment (explicit `leadsEnrichment:
 * []` → successful no-results) and an INVALID source (field missing, every
 * row malformed → deterministic failure, never silently classified as "no
 * results").
 */

import { log } from 'apify';

import { LeadsEnrichmentRowSchema } from './validation.js';
import type { LeadsEnrichmentRow } from './types.js';
import { normalizeUrl } from './utils.js';

const SOURCE_PAGE_SIZE = 50;

/** Structural subset of the SDK dataset client `readSourceDataset` needs. */
export type SourceDatasetLike = {
    getData: (options: { offset: number; limit: number }) => Promise<{ items?: Record<string, unknown>[] }>;
};

export interface SourceItemEvidence {
    /** Dataset items whose `originalStartUrl` normalized to this URL. */
    matchedItems: number;
    /** `leadsEnrichment` was present as an array on at least one item. */
    leadsEnrichmentPresent: boolean;
    /** Valid parsed lead rows across the matched items. */
    validLeadRows: LeadsEnrichmentRow[];
    /** Lead rows that failed schema validation. */
    invalidLeadRows: number;
}

export interface SourceDatasetEvidence {
    datasetId: string;
    /** Total raw items seen while reading (valid keys or not). */
    totalItems: number;
    /** The read loop completed without error. */
    readComplete: boolean;
    readError?: string;
    byUrl: Map<string, SourceItemEvidence>;
}

const emptyEvidence = (): SourceItemEvidence => ({
    matchedItems: 0,
    leadsEnrichmentPresent: false,
    validLeadRows: [],
    invalidLeadRows: 0,
});

/** Read the whole source dataset into per-URL evidence (bounded memory: only
 * parsed lead rows are retained; large unused payload fields are dropped). */
export const readSourceDataset = async (
    dataset: SourceDatasetLike,
    datasetId: string,
): Promise<SourceDatasetEvidence> => {
    const evidence: SourceDatasetEvidence = {
        datasetId,
        totalItems: 0,
        readComplete: false,
        byUrl: new Map(),
    };

    try {
        let offset = 0;
        for (;;) {
            const { items } = await dataset.getData({ offset, limit: SOURCE_PAGE_SIZE });
            if (!items || items.length === 0) break;

            for (const item of items) {
                evidence.totalItems += 1;
                const url = item.originalStartUrl;
                if (typeof url !== 'string' || !url) continue;

                const key = normalizeUrl(url);
                const perUrl = evidence.byUrl.get(key) ?? emptyEvidence();
                perUrl.matchedItems += 1;

                const raw = item.leadsEnrichment;
                if (Array.isArray(raw)) {
                    perUrl.leadsEnrichmentPresent = true;
                    for (const row of raw) {
                        const parsed = LeadsEnrichmentRowSchema.safeParse(row);
                        if (parsed.success) {
                            perUrl.validLeadRows.push(parsed.data);
                        } else {
                            perUrl.invalidLeadRows += 1;
                            log.warning(`Skipping malformed leadsEnrichment row — ${parsed.error.message}`);
                        }
                    }
                }
                evidence.byUrl.set(key, perUrl);
            }

            offset += items.length;
            if (items.length < SOURCE_PAGE_SIZE) break;
        }
        evidence.readComplete = true;
    } catch (err) {
        evidence.readError = err instanceof Error ? err.message : String(err);
    }

    return evidence;
};

export type CompanySourceReasonCode =
    | 'no_company_url'
    | 'unmatched_company'
    | 'source_invalid';

export type CompanySourceClassification =
    | { kind: 'valid_leads'; evidence: SourceItemEvidence }
    | { kind: 'valid_empty'; evidence: SourceItemEvidence }
    | {
    kind: 'invalid_source';
    reasonCode: CompanySourceReasonCode;
    evidence: SourceItemEvidence | null;
    reason: string;
};

/**
 * Classify one company's source evidence. `no_company_url` (no URL supplied)
 * and `unmatched_company` (nothing in the dataset matches) are deterministic
 * company failures — the v2 contract surfaces them as per-company rows with
 * evidence instead of crashing the run before any row is written.
 */
export const classifyCompanySource = (
    companyUrl: string | undefined,
    byUrl: Map<string, SourceItemEvidence>,
): CompanySourceClassification => {
    const trimmed = companyUrl?.trim();
    if (!trimmed) {
        return {
            kind: 'invalid_source',
            reasonCode: 'no_company_url',
            evidence: null,
            reason: 'No company URL provided',
        };
    }

    const evidence = byUrl.get(normalizeUrl(trimmed));
    if (!evidence) {
        return {
            kind: 'invalid_source',
            reasonCode: 'unmatched_company',
            evidence: null,
            reason: 'No matching dataset item found for this company URL',
        };
    }

    if (!evidence.leadsEnrichmentPresent) {
        return {
            kind: 'invalid_source',
            reasonCode: 'source_invalid',
            evidence,
            reason: 'Matched dataset item carries no leadsEnrichment array',
        };
    }

    if (evidence.validLeadRows.length === 0 && evidence.invalidLeadRows > 0) {
        return {
            kind: 'invalid_source',
            reasonCode: 'source_invalid',
            evidence,
            reason: 'Every leadsEnrichment row failed schema validation',
        };
    }

    if (evidence.validLeadRows.length === 0) {
        // Explicit `leadsEnrichment: []` on a complete read — a VALID empty
        // enrichment, not an error.
        return { kind: 'valid_empty', evidence };
    }

    return { kind: 'valid_leads', evidence };
};

/**
 * Per-company verification-evidence check (moved from the old global
 * preflight): when `onlyVerifiedEmails` is enabled and the company has at
 * least one valid lead WITH an email, but NO valid lead carries an
 * emailVerification block, the enrichment run likely had verification
 * disabled — a configuration error for this import, not a global crash.
 * Leads without emails remain intentional skips either way.
 */
export const companyVerificationEvidenceMissing = (
    leads: LeadsEnrichmentRow[],
): boolean => leads.some((lead) => Boolean(lead.email?.trim()))
    && !leads.some((lead) => lead.emailVerification);