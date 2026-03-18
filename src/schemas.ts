import { z } from 'zod';
import { log } from 'apify';

export const HubSpotCompanyResponseSchema = z.object({
    id: z.string(),
    properties: z.record(z.string(), z.any()).optional(),
});

export const HubSpotErrorResponseSchema = z.object({
    status: z.string().optional(),
    message: z.string(),
    correlationId: z.string().optional(),
    category: z.string().optional(),
});

/**
 * Helper function to safely parse and validate API responses
 * Throws a descriptive error if validation fails
 */
export function validateResponse<T>(schema: z.ZodSchema<T>, data: unknown, context: string): T {
    const result = schema.safeParse(data);

    if (!result.success) {
        const errorDetails = result.error.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`).join(', ');
        log.error(`Validation failed for ${context}`, {
            context,
            receivedData: JSON.stringify(data, null, 2),
            validationErrors: errorDetails,
        });
        throw new Error(`Invalid ${context} response structure: ${errorDetails}`);
    }

    return result.data;
}
