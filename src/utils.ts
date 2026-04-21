import type { DataMapping } from './types.js';

type DatasetItem = Record<string, unknown>;

/**
 * Retrieves a value from a nested object using dot notation path (e.g., "user.profile.name")
 */
export const getValueAtPath = (obj: DatasetItem, path: string): unknown => {
    return path.split('.').reduce<unknown>((acc, key) => {
        if (acc == null || typeof acc !== 'object') return undefined;
        return (acc as DatasetItem)[key];
    }, obj);
};

/**
 * Maps a single dataset item to HubSpot company properties using the provided field mappings.
 * All values are converted to strings since HubSpot handles type coercion internally.
 */
export const mapItemToProperties = (
    item: DatasetItem,
    dataMappings: ReadonlyArray<Pick<DataMapping, 'source' | 'target'>>,
): Record<string, string> => {
    const properties: Record<string, string> = {};

    for (const mapping of dataMappings) {
        const value = getValueAtPath(item, mapping.source);
        if (value !== undefined && value !== null) {
            properties[mapping.target] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
    }

    return properties;
};

const hasValue = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    return true;
};

/**
 * Removes keys from `properties` that the caller wants to preserve on the
 * existing HubSpot record. A key is preserved (deleted from the patch) when
 * the existing record already has a non-empty value for it.
 */
export const filterSkippedProperties = (
    properties: Record<string, string>,
    existing: Record<string, unknown>,
    skipTargets: string[],
): Record<string, string> => {
    if (skipTargets.length === 0) return properties;
    const out = { ...properties };
    for (const target of skipTargets) {
        if (hasValue(existing[target])) delete out[target];
    }
    return out;
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
export const buildItemsByUrl = (items: DatasetItem[]): Map<string, DatasetItem> => {
    const map = new Map<string, DatasetItem>();

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
