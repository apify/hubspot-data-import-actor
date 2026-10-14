import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureApifyPropertiesExist } from '../api.js';

const mocks = vi.hoisted(() => ({
    coreApi: { create: vi.fn(), getByName: vi.fn() },
    groupsApi: { create: vi.fn() },
    log: { warning: vi.fn(), info: vi.fn() },
}));

// A regular function (not an arrow function) so `new Client(...)` works —
// arrow functions have no [[Construct]] slot and throw "not a constructor".
vi.mock('@hubspot/api-client', () => ({
    Client: vi.fn(function MockClient() {
        return {
            crm: {
                properties: {
                    coreApi: mocks.coreApi,
                    groupsApi: mocks.groupsApi,
                },
            },
        };
    }),
}));

vi.mock('apify', () => ({
    log: mocks.log,
}));

const STAMP = 'apify_last_enriched_at';
const conflict = () => ({ code: 409, message: 'Conflict', body: 'already exists' });
const badRequest = () => ({ code: 400, message: 'Bad request', body: 'duplicate group' });
const forbidden = () => ({ code: 403, message: 'Forbidden', body: 'missing scope' });
const serverError = () => ({ code: 500, message: 'Server', body: 'boom' });

describe('ensureApifyPropertiesExist', () => {
    beforeEach(() => {
        mocks.coreApi.create.mockReset();
        mocks.coreApi.create.mockResolvedValue(undefined);
        mocks.coreApi.getByName.mockReset();
        mocks.coreApi.getByName.mockResolvedValue(undefined);
        mocks.groupsApi.create.mockReset();
        mocks.groupsApi.create.mockResolvedValue(undefined);
        mocks.log.warning.mockReset();
        mocks.log.info.mockReset();
    });

    describe('happy path — property created', () => {
        it('creates the group and property and returns true', async () => {
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(true);
            expect(mocks.groupsApi.create).toHaveBeenCalledWith('contacts', expect.objectContaining({
                name: 'apify',
                label: 'Apify',
            }));
            expect(mocks.coreApi.create).toHaveBeenCalledWith('contacts', expect.objectContaining({
                name: STAMP,
                type: 'datetime',
                fieldType: 'date',
                groupName: 'apify',
            }));
            expect(mocks.coreApi.getByName).not.toHaveBeenCalled();
        });

        it('sends the correct datetime/date fieldType pair (not fieldType: "datetime")', async () => {
            await ensureApifyPropertiesExist('tok', STAMP);
            const payload = mocks.coreApi.create.mock.calls[0][1] as { type: string; fieldType: string };
            expect(payload.type).toBe('datetime');
            expect(payload.fieldType).toBe('date');
        });
    });

    describe('existing group tolerated', () => {
        it('tolerates a 409 on group creation and still creates the property', async () => {
            mocks.groupsApi.create.mockRejectedValueOnce(conflict());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(true);
            expect(mocks.coreApi.create).toHaveBeenCalled();
        });

        it('tolerates a 400 on group creation and still creates the property', async () => {
            mocks.groupsApi.create.mockRejectedValueOnce(badRequest());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(true);
            expect(mocks.coreApi.create).toHaveBeenCalled();
        });
    });

    describe('existing property (409) — compatibility check', () => {
        it('reuses a compatible writable datetime property and returns true', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(conflict());
            mocks.coreApi.getByName.mockResolvedValueOnce({
                type: 'datetime', fieldType: 'date', calculated: false, archived: false,
            });
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(true);
            expect(mocks.coreApi.getByName).toHaveBeenCalledWith('contacts', STAMP);
        });

        it('disables stamping when the existing property has the wrong type (number)', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(conflict());
            mocks.coreApi.getByName.mockResolvedValueOnce({
                type: 'number', fieldType: 'number', calculated: false, archived: false,
            });
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });

        it('disables stamping when the existing property is calculated', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(conflict());
            mocks.coreApi.getByName.mockResolvedValueOnce({
                type: 'datetime', fieldType: 'date', calculated: true, archived: false,
            });
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });

        it('disables stamping when the existing property is archived', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(conflict());
            mocks.coreApi.getByName.mockResolvedValueOnce({
                type: 'datetime', fieldType: 'date', calculated: false, archived: true,
            });
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });

        it('disables stamping when the existing property cannot be read back', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(conflict());
            mocks.coreApi.getByName.mockRejectedValueOnce(serverError());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });
    });

    describe('error handling — never throws, disables observability', () => {
        it('returns false on 403 during property creation (missing schema scope)', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(forbidden());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalledWith(
                expect.stringContaining('crm.schemas.contacts.write'),
            );
        });

        it('returns false on 403 during group creation', async () => {
            mocks.groupsApi.create.mockRejectedValueOnce(forbidden());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });

        it('returns false on other group-creation errors (500)', async () => {
            mocks.groupsApi.create.mockRejectedValueOnce(serverError());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });

        it('returns false on other property-creation errors (500)', async () => {
            mocks.coreApi.create.mockRejectedValueOnce(serverError());
            const result = await ensureApifyPropertiesExist('tok', STAMP);
            expect(result).toBe(false);
            expect(mocks.log.warning).toHaveBeenCalled();
        });
    });
});