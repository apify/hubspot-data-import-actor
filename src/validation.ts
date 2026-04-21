import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const LEADS_ENRICHMENT_FIELD_KEYS = [
    'personId', 'firstName', 'lastName', 'fullName', 'linkedinProfile',
    'email', 'mobileNumber', 'jobTitle', 'industry', 'city', 'state',
    'country', 'companyId', 'companyName', 'companyWebsite', 'companySize',
    'companyLinkedin', 'companyCity', 'companyState', 'companyCountry',
    'companyPhoneNumber', 'headline', 'departments', 'seniority',
    'photoUrl', 'twitter',
] as const;

const LEADS_ENRICHMENT_FIELD_KEY_SET = new Set<string>(LEADS_ENRICHMENT_FIELD_KEYS);

export const LeadsEnrichmentRowSchema = z.object({
    personId: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    fullName: z.string().nullable().optional(),
    linkedinProfile: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    mobileNumber: z.string().nullable().optional(),
    jobTitle: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    companyId: z.string().nullable().optional(),
    companyName: z.string().nullable().optional(),
    companyWebsite: z.string().nullable().optional(),
    companySize: z.string().nullable().optional(),
    companyLinkedin: z.string().nullable().optional(),
    companyCity: z.string().nullable().optional(),
    companyState: z.string().nullable().optional(),
    companyCountry: z.string().nullable().optional(),
    companyPhoneNumber: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    departments: z.array(z.string()).nullable().optional(),
    seniority: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    twitter: z.string().nullable().optional(),
});

const DataMappingSchema = z.object({
    source: nonEmptyString,
    target: nonEmptyString,
    overwriteMode: z.enum(['overwrite', 'skip']).default('overwrite'),
});

export const ActorInputSchema = z.object({
    hubspotAccessToken: nonEmptyString.describe('HubSpot access token (private app token or OAuth access token)'),
    datasetId: nonEmptyString.describe('Apify dataset ID to import from'),
    importMode: z.literal('contacts').describe('Import mode — only "contacts" is supported'),
    runId: nonEmptyString.describe('Backend run ID used to correlate callback reports'),
    runSecret: nonEmptyString.describe('Shared secret accompanying callback POSTs for authentication'),
    callbackUrl: z.url().describe('Backend URL to POST per-company import stats to'),
    companyUrlMapping: z
        .array(z.object({ url: z.string().optional(), companyId: nonEmptyString }))
        .min(1, 'Must have at least one company to HubSpot ID mapping'),
    dataMappings: z
        .array(DataMappingSchema)
        .min(1, 'Must have at least one valid mapping with non-empty "source" and "target" fields')
        .superRefine((mappings, ctx) => {
            mappings.forEach((m, i) => {
                if (!LEADS_ENRICHMENT_FIELD_KEY_SET.has(m.source)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: [i, 'source'],
                        message: `"${m.source}" is not a valid leadsEnrichment field. Allowed: ${LEADS_ENRICHMENT_FIELD_KEYS.join(', ')}`,
                    });
                }
            });
        }),
    deduplication: z.enum(['email', 'phone']).default('email'),
});

export type ValidatedActorInput = z.infer<typeof ActorInputSchema>;

/**
 * Validates the actor input configuration using Zod.
 * Throws descriptive errors if any required fields are missing or invalid.
 */
export const validateInput = (input: unknown): ValidatedActorInput => {
    if (!input) {
        throw new Error('No input provided');
    }

    return ActorInputSchema.parse(input);
};
