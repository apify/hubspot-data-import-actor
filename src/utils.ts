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

/**
 * Normalizes a URL for comparison by stripping protocol, www prefix, and trailing slashes.
 */
export const normalizeUrl = (url: string): string => {
    let normalized = url.trim().toLowerCase();
    normalized = normalized.replace(/^https?:\/\//, '');
    normalized = normalized.replace(/^www\./, '');
    normalized = normalized.replace(/\/+$/, '');
    return normalized;
};

/**
 * Builds a lookup map from dataset items keyed by normalized `originalStartUrl`.
 * Each URL maps to a single dataset item (lead enrichment produces one item per URL).
 */
export const buildItemsByUrl = (items: Record<string, any>[]): Map<string, Record<string, any>> => {
    const map = new Map<string, Record<string, any>>();

    for (const item of items) {
        const url = item.originalStartUrl;
        if (typeof url !== 'string' || !url) continue;
        const key = normalizeUrl(url);
        if (!map.has(key)) {
            map.set(key, item);
        }
    }

    return map;
};
