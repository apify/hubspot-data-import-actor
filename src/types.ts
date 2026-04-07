export interface DataMapping {
    source: string;
    target: string;
}

export interface CompanyUrlMapping {
    url?: string;
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
    status: 'imported' | 'skipped' | 'failed';
    success: boolean;
    propertiesUpdated: number;
    error?: string;
    skipReason?: string;
}

