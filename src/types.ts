/**
 * Result contracts of the HubSpot data-import Actor.
 *
 * Result contract version 2 (resultVersion: 2 on every row and on OUTPUT):
 * the top-level counters are CORRECTED — `failed` is counted separately from
 * `skipped` (v1 collapsed failed writes into `skipped`) and every row carries
 * explicit completeness. Rows WITHOUT `resultVersion` are legacy (v1) rows:
 * consumers must read them with the legacy interpretation and never relabel
 * their `skipped` as intentional skips.
 */

/** Result-row contract version written by this build. */
export const RESULT_VERSION_2 = 2;

export type OverwriteMode = 'overwrite' | 'skip';

export interface DataMapping {
    source: string;
    target: string;
    overwriteMode: OverwriteMode;
}

export interface CompanyUrlMapping {
    url?: string;
    companyId: string;
}

/**
 * Per-company write statistics (v2). `rowsTotal` keeps its legacy meaning:
 * the number of VALID parsed lead rows for the company (not raw dataset
 * items). Malformed source rows are counted in the source evidence instead.
 */
export interface ContactImportStats {
    created: number;
    updated: number;
    /** Intentional skips only — failed writes never inflate this. */
    skipped: number;
    /** Lookups/creates/updates that failed after safe retries. */
    failed: number;
    rowsTotal: number;
    /** First error observed while processing this company (v1-compatible). */
    error?: string;
}

/** Legacy-compatible company row status (dataset view). */
export type CompanyStatus = 'imported' | 'skipped' | 'failed';

/** v2 result classification for one company. */
export type CompanyOutcome = 'complete' | 'partial' | 'no_results' | 'failed';

/** Why processing of this company ended the way it did. */
export type CompanyTerminalReason =
    | 'complete'
    | 'no_results'
    | 'no_change'
    | 'source_invalid'
    | 'unmatched_company'
    | 'no_company_url'
    | 'verification_data_missing'
    | 'auth_failed'
    | 'unexpected_error'
    | 'progress_persist_failed'
    | 'interrupted';

/** Per-company source-dataset evidence (what the matched items carried). */
export interface CompanySourceEvidence {
    /** Dataset items that matched this company's normalized URL. */
    matchedItems: number;
    /** Valid parsed lead rows across those items. */
    validLeadRows: number;
    /** Lead rows that failed schema validation (never counted as skips). */
    invalidLeadRows: number;
    /** Whether the source-dataset read completed without error. */
    readComplete: boolean;
}

/** One per-company result row (kind = 'company', resultVersion 2). */
export interface CompanyResult extends ContactImportStats {
    kind: 'company';
    resultVersion: number;
    /** Stable within one Actor run for this company occurrence. */
    resultId: string;
    /** Index in `companyUrlMapping` (stable across migrations). */
    companyIndex: number;
    companyId: string;
    companyUrl: string;
    /** Legacy view status (kept for existing dataset views/consumers). */
    status: CompanyStatus;
    /** v2 classification the backend workflow consumes. */
    outcome: CompanyOutcome;
    /** False = result evidence is INCOMPLETE (e.g. interrupted mid-company);
     * never implies zero writes — see `terminalReason`. */
    resultsComplete: boolean;
    terminalReason: CompanyTerminalReason;
    source: CompanySourceEvidence;
}

export type ContactStatus =
    | 'created'
    | 'updated'
    | 'skipped_no_identifier'
    | 'skipped_unverified_email'
    | 'skipped_already_complete'
    | 'failed';

/** One per-contact detail row (kind = 'contact', resultVersion 2). */
export interface ContactResult {
    kind: 'contact';
    resultVersion: number;
    /** Stable within one Actor run for this lead occurrence. */
    resultId: string;
    /** Index of the lead within the company's valid lead rows. */
    sourceIndex: number;
    companyId: string;
    status: ContactStatus;
    identifier: string;
    displayName: string;
    propertiesWritten: string[];
    errorMessage?: string;
}

export interface LeadsEnrichmentRow {
    personId?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    linkedinProfile?: string | null;
    email?: string | null;
    mobileNumber?: string | null;
    jobTitle?: string | null;
    industry?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    companyId?: string | null;
    companyName?: string | null;
    companyWebsite?: string | null;
    companySize?: string | null;
    companyLinkedin?: string | null;
    companyCity?: string | null;
    companyState?: string | null;
    companyCountry?: string | null;
    companyPhoneNumber?: string | null;
    headline?: string | null;
    departments?: string[] | null;
    seniority?: string | null;
    photoUrl?: string | null;
    twitter?: string | null;
    emailVerification?: {
        subResult?: string | null;
        email?: string | null;
        quality?: '' | 'good' | 'bad' | 'risky' | 'unknown' | null;
        result?: 'ok' | 'catch_all' | 'unknown' | 'error' | 'disposable' | 'invalid' | null;
        free?: boolean | null;
        role?: boolean | null;
        error?: string | null;
    } | null;
}

/** Run-level OUTPUT (v2). Persisted on controlled failures as well. */
export interface ActorOutput {
    resultVersion: number;
    totalCompanies: number;
    totalCreated: number;
    totalUpdated: number;
    totalSkipped: number;
    totalFailed: number;
    totalRows: number;
    unmatchedCompanies: string[];
    results: CompanyResult[];
    datasetId: string;
    /** False = at least one company's evidence is incomplete. */
    resultsComplete: boolean;
    terminalReason: CompanyTerminalReason;
    startTime: string;
    endTime: string;
    duration: number;
}