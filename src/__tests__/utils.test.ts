import { describe, it, expect } from 'vitest';
import { filterSkippedProperties, findDeadSources, getValueAtPath, mapItemToProperties, normalizeUrl } from '../utils.js';

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

    it('joins arrays with semicolons', () => {
        const item = { tags: ['a', 'b'] };
        const mappings = [{ source: 'tags', target: 'tags' }];
        expect(mapItemToProperties(item, mappings)).toEqual({ tags: 'a;b' });
    });

    it('JSON-stringifies object elements inside joined arrays', () => {
        const item = { items: [{ x: 1 }, { y: 2 }] };
        const mappings = [{ source: 'items', target: 'items' }];
        expect(mapItemToProperties(item, mappings)).toEqual({ items: '{"x":1};{"y":2}' });
    });

    it('handles mixed arrays of primitives and objects', () => {
        const item = { tags: ['a', { b: 1 }, 'c'] };
        const mappings = [{ source: 'tags', target: 'tags' }];
        expect(mapItemToProperties(item, mappings)).toEqual({ tags: 'a;{"b":1};c' });
    });

    it('serializes plain objects as JSON', () => {
        const item = { meta: { x: 1, y: 2 } };
        const mappings = [{ source: 'meta', target: 'meta' }];
        expect(mapItemToProperties(item, mappings)).toEqual({ meta: '{"x":1,"y":2}' });
    });

    it('skips empty arrays instead of writing an empty string', () => {
        const item = { tags: [] as string[] };
        const mappings = [{ source: 'tags', target: 'tags' }];
        expect(mapItemToProperties(item, mappings)).toEqual({});
    });

    it('returns empty object when no mappings match', () => {
        const item = { x: 1 };
        const mappings = [{ source: 'missing', target: 'prop' }];
        expect(mapItemToProperties(item, mappings)).toEqual({});
    });
});

describe('findDeadSources', () => {
    it('flags sources that resolve on no row', () => {
        const leads = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
        expect(findDeadSources(leads, ['email', 'emial'])).toEqual(['emial']);
    });

    it('resolves dot-path sources', () => {
        const leads = [{ meta: { industry: 'Tech' } }];
        expect(findDeadSources(leads, ['meta.industry'])).toEqual([]);
    });

    it('treats null and empty arrays as dead, matching the write path', () => {
        const leads = [{ a: null, b: [] as string[], c: 'ok' }];
        expect(findDeadSources(leads, ['a', 'b', 'c'])).toEqual(['a', 'b']);
    });

    it('returns empty when every source resolves on at least one row', () => {
        const leads = [{ a: 1 }, { b: 2 }];
        expect(findDeadSources(leads, ['a', 'b'])).toEqual([]);
    });

    it('flags every source when there are no rows', () => {
        expect(findDeadSources([], ['a'])).toEqual(['a']);
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
