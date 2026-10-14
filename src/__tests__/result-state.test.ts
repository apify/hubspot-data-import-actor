import { describe, it, expect } from 'vitest';
import type { CompanyResult } from '../types.js';
import { RESULT_VERSION_2 } from '../types.js';
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

    it('converts a legacy v1 record losslessly (completed results + index preserved)', () => {
        const legacyRow = companyRow();
        const parsed = parseSavedState({
            results: [legacyRow],
            processedIndex: 1,
        });

        expect(parsed?.stateVersion).toBe(STATE_VERSION_2);
        expect(parsed?.nextCompanyIndex).toBe(1);
        expect(parsed?.completedCompanies).toEqual([legacyRow]);
        expect(parsed?.active).toBeUndefined(); // v1 had no active-company marker
    });
});