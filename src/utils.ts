import type { DataMapping } from './types.js';

/**
 * Retrieves a value from a nested object using dot notation path (e.g., "user.profile.name")
 */
export const getValueAtPath = (obj: any, path: string): any => {
    return path.split('.').reduce((acc, key) => {
        if (acc == null || typeof acc !== 'object') return undefined;
        return acc[key];
    }, obj);
};

/**
 * Maps a single dataset item to HubSpot company properties using the provided field mappings.
 * All values are converted to strings since HubSpot handles type coercion internally.
 */
export const mapItemToProperties = (item: Record<string, any>, dataMappings: DataMapping[]): Record<string, string> => {
    const properties: Record<string, string> = {};

    for (const mapping of dataMappings) {
        const value = getValueAtPath(item, mapping.source);
        if (value !== undefined && value !== null) {
            properties[mapping.target] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
    }

    return properties;
};
