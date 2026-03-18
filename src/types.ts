export interface DataMapping {
    source: string;
    target: string;
}

export interface ActorInput {
    hubspotAccessToken: string;
    datasetId: string;
    companyId: string;
    dataMappings: DataMapping[];
}

export interface ActorOutput {
    success: boolean;
    companyId: string;
    datasetId: string;
    propertiesUpdated: number;
    startTime: string;
    endTime: string;
    duration: number;
}
