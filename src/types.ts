export interface DataMapping {
    source: string;
    target: string;
}

export interface CompanyUrlMapping {
    url?: string;
    companyId: string;
}

export interface CompanyResult {
    companyId: string;
    companyUrl: string;
    status: 'imported' | 'skipped' | 'failed';
    success: boolean;
    propertiesUpdated: number;
    error?: string;
    skipReason?: string;
}

export interface ActorOutput {
    totalCompanies: number;
    successCount: number;
    skippedCount: number;
    failureCount: number;
    unmatchedCompanies: string[];
    results: CompanyResult[];
    datasetId: string;
    startTime: string;
    endTime: string;
    duration: number;
}
