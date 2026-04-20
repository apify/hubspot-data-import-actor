export interface DataMapping {
    source: string;
    target: string;
}

export interface CompanyUrlMapping {
    url?: string;
    companyId: string;
}

export interface ContactImportStats {
    created: number;
    updated: number;
    skipped: number;
    rowsTotal: number;
    error?: string;
}

export interface CompanyResult extends ContactImportStats {
    companyId: string;
    companyUrl: string;
    status: 'imported' | 'skipped' | 'failed';
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
}

export interface ActorOutput {
    totalCompanies: number;
    totalCreated: number;
    totalUpdated: number;
    totalSkipped: number;
    totalRows: number;
    unmatchedCompanies: string[];
    results: CompanyResult[];
    datasetId: string;
    startTime: string;
    endTime: string;
    duration: number;
}
