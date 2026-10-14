import { describe, it, expect } from 'vitest';
import type { CompanyResult } from '../types.js';
import { RESULT_VERSION_2, isLegacyCompanyRow } from '../types.js';
import {
    STATE_VERSION_2,
    newMigrationState,
    parseSavedState,
} from '../result-state.js';

const companyRow = (overrides: Partial<CompanyResult> = {}): CompanyResult => ({
    kind: 'company',
    resultVersion: RESULT_VERSION_2,
    resultId: 'company:c1:0',
    companyIndex: 0,
    companyId: 'c1',
    companyUrl: 'https://example.com',
    status: 'imported',
    outcome: 'complete',
    created: 1,
    updated: 0,
    skipped: 0,
    failed: 0,
    rowsTotal: 1,
    resultsComplete: true,
    terminalReason: 'complete',
    source: { matchedItems: 1, validLeadRows: 1, invalidLeadRows: 0, readComplete: true },
    ...overrides,
});

describe('newMigrationState', () => {
    it('starts a fresh v2 state with no completed companies and no terminal marker', () => {
        const state = newMigrationState(new Date('2026-01-01T00:00:00Z'));
        expect(state.stateVersion).toBe(STATE_VERSION_2);
        expect(state.nextCompanyIndex).toBe(0);
        expect(state.completedCompanies).toEqual([]);
        expect(state.active).toBeUndefined();
        expect(state.terminal).toBeUndefined();
        expect(state.startTime).toBe('2026-01-01T00:00:00.000Z');
    });
});

describe('parseSavedState', () => {
    it('returns null for null/undefined/invalid shapes (caller starts fresh)', () => {
        expect(parseSavedState(null)).toBeNull();
        expect(parseSavedState(undefined)).toBeNull();
        expect(parseSavedState('nonsense')).toBeNull();
        expect(parseSavedState({ random: true })).toBeNull();
        expect(parseSavedState({ stateVersion: 99 })).toBeNull();
    });

    it('round-trips a v2 state untouched', () => {
        const state = newMigrationState(new Date());
        state.nextCompanyIndex = 2;
        state.completedCompanies.push(companyRow());
        state.active = {
            companyIndex: 2,
            companyId: 'c3',
            companyUrl: 'https://third.com',
            phase: 'processing',
            stats: { created: 1, updated: 0, skipped: 0, failed: 0, rowsTotal: 4 },
            lastCompletedLeadIndex: 0,
            source: { matchedItems: 1, validLeadRows: 4, invalidLeadRows: 0, readComplete: true },
        };

        expect(parseSavedState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    });

    it('rejects a v2-shaped record with a broken payload', () => {
        expect(parseSavedState({ stateVersion: STATE_VERSION_2, nextCompanyIndex: 'nope' })).toBeNull();
        expect(parseSavedState({ stateVersion: STATE_VERSION_2, completedCompanies: {} })).toBeNull();
    });

    it('converts a REAL legacy v1 record with normalized legacy rows (no fabricated v2 certainty)', () => {
        // Actual v1 shape: no resultVersion, no failed, no completeness fields.
        // Its `skipped` may include failed writes — never re-labelled as v2.
        const legacyRow = {
            kind: 'company',
            companyId: 'c1',
            companyUrl: 'https://example.com',
            status: 'imported' as const,
            created: 1,
            updated: 0,
            skipped: 2,
            rowsTotal: 3,
        };
        const parsed = parseSavedState({
            results: [legacyRow, { broken: true }], // a malformed row is dropped, not carried
            processedIndex: 1,
        });

        expect(parsed?.stateVersion).toBe(STATE_VERSION_2);
        expect(parsed?.nextCompanyIndex).toBe(1);
        expect(parsed?.active).toBeUndefined(); // v1 had no active-company marker
        expect(parsed?.completedCompanies).toEqual([{
            kind: 'company',
            companyId: 'c1',
            companyUrl: 'https://example.com',
            status: 'imported',
            created: 1,
            updated: 0,
            skipped: 2,
            rowsTotal: 3,
        }]);
        // The converted row keeps its LEGACY identity — `isLegacyCompanyRow`
        // stays true so consumers never read it as v2.
        expect(isLegacyCompanyRow(parsed?.completedCompanies[0])).toBe(true);
        const row = parsed?.completedCompanies[0] as unknown as Record<string, unknown>;
        expect(row.resultVersion).toBeUndefined();
        expect(row.failed).toBeUndefined();
        expect(row.resultsComplete).toBeUndefined();
        expect(row.terminalReason).toBeUndefined();
    });

    it('normalizes non-numeric legacy counters defensively instead of fabricating values', () => {
        const parsed = parseSavedState({
            results: [{
                kind: 'company',
                companyId: 'c1',
                companyUrl: 'https://example.com',
                status: 'imported',
                created: 'not-a-number',
                updated: null,
                skipped: 2,
                rowsTotal: 3,
                error: 'search failed',
            }],
            processedIndex: 1,
        });
        const row = parsed?.completedCompanies[0] as unknown as Record<string, unknown>;
        expect(row.created).toBe(0);
        expect(row.updated).toBe(0);
        expect(row.skipped).toBe(2);
        expect(row.error).toBe('search failed');
    });
});