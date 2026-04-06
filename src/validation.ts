import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

const DataMappingSchema = z.object({
    source: nonEmptyString,
    target: nonEmptyString,
});

export const ActorInputSchema = z.object({
    hubspotAccessToken: nonEmptyString.describe('HubSpot access token (private app token or OAuth access token)'),
    datasetId: nonEmptyString.describe('Apify dataset ID to import from'),
    companyUrlMapping: z
        .array(z.object({ url: z.string().optional(), companyId: nonEmptyString }))
        .min(1, 'Must have at least one company to HubSpot ID mapping'),
    dataMappings: z
        .array(DataMappingSchema)
        .min(1, 'Must have at least one valid mapping with non-empty "source" and "target" fields'),
});

export type ValidatedActorInput = z.infer<typeof ActorInputSchema>;

/**
 * Validates the actor input configuration using Zod.
 * Throws descriptive errors if any required fields are missing or invalid.
 */
export const validateInput = (input: unknown): ValidatedActorInput => {
    return ActorInputSchema.parse(input);
};
