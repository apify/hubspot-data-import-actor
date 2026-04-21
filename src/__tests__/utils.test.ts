import { describe, it, expect } from 'vitest';
import { filterSkippedProperties, getValueAtPath, mapItemToProperties, normalizeUrl, buildItemsByUrl } from '../utils.js';

describe('getValueAtPath', () => {
    it('returns top-level value', () => {
        expect(getValueAtPath({ name: 'Acme' }, 'name')).toBe('Acme');
    });

    it('returns nested value via dot notation', () => {
        expect(getValueAtPath({ meta: { industry: 'Tech' } }, 'meta.industry')).toBe('Tech');
    });

    it('returns undefined for missing path', () => {
        expect(getValueAtPath({ a: 1 }, 'b')).toBeUndefined();
    });

    it('returns undefined for deeply missing path', () => {
        expect(getValueAtPath({ a: { b: 1 } }, 'a.c.d')).toBeUndefined();
    });

    it('returns undefined when traversing through a primitive', () => {
        expect(getValueAtPath({ a: 42 }, 'a.b')).toBeUndefined();
    });

    it('returns undefined for null object', () => {
        expect(getValueAtPath({ a: null } as Record<string, unknown>, 'a.b')).toBeUndefined();
    });
});

describe('mapItemToProperties', () => {
    it('maps simple fields', () => {
        const item = { revenue: 1000, industry: 'Tech' };
        const mappings = [
            { source: 'revenue', target: 'annualrevenue' },
            { source: 'industry', target: 'industry' },
        ];
        expect(mapItemToProperties(item, mappings)).toEqual({
            annualrevenue: '1000',
            industry: 'Tech',
        });
    });

    it('maps nested fields', () => {
        const item = { meta: { industry: 'Finance' } };
        const mappings = [{ source: 'meta.industry', target: 'industry' }];
        expect(mapItemToProperties(item, mappings)).toEqual({ industry: 'Finance' });
    });

    it('skips null and undefined values', () => {
        const item = { a: null, b: undefined, c: 'ok' };
        const mappings = [
            { source: 'a', target: 'pa' },
            { source: 'b', target: 'pb' },
            { source: 'c', target: 'pc' },
        ];
        expect(mapItemToProperties(item, mappings)).toEqual({ pc: 'ok' });
    });

    it('serializes objects as JSON', () => {
        const item = { tags: ['a', 'b'] };
        const mappings = [{ source: 'tags', target: 'tags' }];
        expect(mapItemToProperties(item, mappings)).toEqual({ tags: '["a","b"]' });
    });

    it('returns empty object when no mappings match', () => {
        const item = { x: 1 };
        const mappings = [{ source: 'missing', target: 'prop' }];
        expect(mapItemToProperties(item, mappings)).toEqual({});
    });
});

describe('filterSkippedProperties', () => {
    it('returns input unchanged when skipTargets is empty', () => {
        const props = { firstname: 'Jane', email: 'j@x.com' };
        expect(filterSkippedProperties(props, { firstname: 'Old' }, [])).toEqual(props);
    });

    it('drops a key when existing has a non-empty string for it', () => {
        const out = filterSkippedProperties(
            { firstname: 'Jane', jobtitle: 'CEO' },
            { firstname: 'Old', jobtitle: 'CTO' },
            ['jobtitle'],
        );
        expect(out).toEqual({ firstname: 'Jane' });
    });

    it('keeps a key when existing value is empty string', () => {
        const out = filterSkippedProperties(
            { jobtitle: 'CEO' },
            { jobtitle: '' },
            ['jobtitle'],
        );
        expect(out).toEqual({ jobtitle: 'CEO' });
    });

    it('keeps a key when existing value is whitespace only', () => {
        const out = filterSkippedProperties(
            { jobtitle: 'CEO' },
            { jobtitle: '   ' },
            ['jobtitle'],
        );
        expect(out).toEqual({ jobtitle: 'CEO' });
    });

    it('keeps a key when existing value is null or missing', () => {
        const out = filterSkippedProperties(
            { jobtitle: 'CEO', industry: 'Tech' },
            { jobtitle: null },
            ['jobtitle', 'industry'],
        );
        expect(out).toEqual({ jobtitle: 'CEO', industry: 'Tech' });
    });

    it('only removes listed skipTargets', () => {
        const out = filterSkippedProperties(
            { firstname: 'Jane', jobtitle: 'CEO' },
            { firstname: 'Old', jobtitle: 'CTO' },
            ['firstname'],
        );
        expect(out).toEqual({ jobtitle: 'CEO' });
    });

    it('does not mutate the input properties', () => {
        const props = { jobtitle: 'CEO' };
        filterSkippedProperties(props, { jobtitle: 'CTO' }, ['jobtitle']);
        expect(props).toEqual({ jobtitle: 'CEO' });
    });
});

describe('normalizeUrl', () => {
    it('strips https protocol', () => {
        expect(normalizeUrl('https://example.com')).toBe('example.com');
    });

    it('strips http protocol', () => {
        expect(normalizeUrl('http://example.com')).toBe('example.com');
    });

    it('strips www prefix', () => {
        expect(normalizeUrl('https://www.example.com')).toBe('example.com');
    });

    it('strips trailing slashes', () => {
        expect(normalizeUrl('https://example.com/')).toBe('example.com');
    });

    it('lowercases the URL', () => {
        expect(normalizeUrl('HTTPS://Example.COM')).toBe('example.com');
    });

    it('handles bare domain', () => {
        expect(normalizeUrl('example.com')).toBe('example.com');
    });

    it('trims whitespace', () => {
        expect(normalizeUrl('  example.com  ')).toBe('example.com');
    });
});

describe('buildItemsByUrl', () => {
    it('builds map from items with originalStartUrl', () => {
        const items = [
            { originalStartUrl: 'https://example.com', data: 1 },
            { originalStartUrl: 'https://other.com', data: 2 },
        ];
        const map = buildItemsByUrl(items);
        expect(map.size).toBe(2);
        expect(map.get('example.com')).toEqual(items[0]);
        expect(map.get('other.com')).toEqual(items[1]);
    });

    it('keeps the first item for duplicate URLs', () => {
        const items = [
            { originalStartUrl: 'https://example.com', version: 1 },
            { originalStartUrl: 'https://example.com', version: 2 },
        ];
        const map = buildItemsByUrl(items);
        expect(map.size).toBe(1);
        expect(map.get('example.com')).toEqual(items[0]);
    });

    it('skips items without originalStartUrl', () => {
        const items = [
            { otherField: 'no url' },
            { originalStartUrl: '', data: 1 },
            { originalStartUrl: 'https://example.com', data: 2 },
        ];
        const map = buildItemsByUrl(items);
        expect(map.size).toBe(1);
    });

    it('normalizes URLs for matching', () => {
        const items = [
            { originalStartUrl: 'https://www.Example.COM/', data: 1 },
        ];
        const map = buildItemsByUrl(items);
        expect(map.get('example.com')).toEqual(items[0]);
    });
});
