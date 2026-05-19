import type { DataMapping } from './types.js';

type DatasetItem = Record<string, unknown>;

// Maps common country name variants to ISO 3166-1 alpha-2 codes.
// HubSpot accepts ISO codes for all countries, making them the stable target format.
// Only variants that differ from the exact ISO code need entries here.
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
    // Modern renames not yet in many datasets
    czechia: 'CZ',
    'czech republic': 'CZ',
    'north macedonia': 'MK',
    'republic of north macedonia': 'MK',
    'macedonia (fyrom)': 'MK',
    eswatini: 'SZ',
    swaziland: 'SZ',
    'timor-leste': 'TL',
    'east timor': 'TL',
    myanmar: 'MM',
    'myanmar (burma)': 'MM',
    burma: 'MM',
    // Common English name variants
    russia: 'RU',
    'russian federation': 'RU',
    'south korea': 'KR',
    'republic of korea': 'KR',
    'north korea': 'KP',
    "democratic people's republic of korea": 'KP',
    iran: 'IR',
    'islamic republic of iran': 'IR',
    syria: 'SY',
    'syrian arab republic': 'SY',
    'ivory coast': 'CI',
    "cote d'ivoire": 'CI',
    "côte d'ivoire": 'CI',
    'democratic republic of the congo': 'CD',
    'dr congo': 'CD',
    'republic of the congo': 'CG',
    congo: 'CG',
    'united kingdom': 'GB',
    'great britain': 'GB',
    england: 'GB',
    'united states': 'US',
    'united states of america': 'US',
    usa: 'US',
    'united arab emirates': 'AE',
    uae: 'AE',
    taiwan: 'TW',
    'republic of china': 'TW',
    'vietnam': 'VN',
    'viet nam': 'VN',
    laos: 'LA',
    "lao people's democratic republic": 'LA',
    moldova: 'MD',
    'republic of moldova': 'MD',
    'palestine': 'PS',
    'state of palestine': 'PS',
    kosovo: 'XK',
    'republic of kosovo': 'XK',
    netherlands: 'NL',
    holland: 'NL',
    'cabo verde': 'CV',
    'cape verde': 'CV',
    brunei: 'BN',
    'brunei darussalam': 'BN',
    macau: 'MO',
    macao: 'MO',
    tanzania: 'TZ',
    'united republic of tanzania': 'TZ',
    bolivia: 'BO',
    'plurinational state of bolivia': 'BO',
    venezuela: 'VE',
    'bolivarian republic of venezuela': 'VE',
};

const normalizeCountry = (value: string): string => {
    return COUNTRY_NAME_TO_ISO[value.toLowerCase().trim()] ?? value;
};

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
            const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
            properties[mapping.target] = mapping.target === 'country' ? normalizeCountry(raw) : raw;
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
