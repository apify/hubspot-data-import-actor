export interface DataMapping {
    source: string;
    target: string;
}

export interface CompanyUrlMapping {
    url: string;
    companyId: string;
}

export interface ActorInput {
    hubspotAccessToken: string;
    datasetId: string;
    companyUrlMapping: CompanyUrlMapping[];
    dataMappings: DataMapping[];
}

export interface CompanyResult {
    companyId: string;
    companyUrl: string;
    success: boolean;
    propertiesUpdated: number;
    error?: string;
}

export interface ActorOutput {
    totalCompanies: number;
    successCount: number;
    failureCount: number;
    unmatchedCompanies: string[];
    results: CompanyResult[];
    datasetId: string;
    startTime: string;
    endTime: string;
    duration: number;
}
