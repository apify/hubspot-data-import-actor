import { log } from 'apify';
import type { ContactImportStats } from './types.js';

export const postImportCallback = async (
    callbackUrl: string,
    runId: string,
    runSecret: string,
    companyId: string,
    stats: ContactImportStats,
): Promise<void> => {
    const url = new URL(callbackUrl);
    url.searchParams.set('runId', runId);
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('runSecret', runSecret);

    const body = {
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        rowsTotal: stats.rowsTotal,
        ...(stats.error ? { error: stats.error } : {}),
    };

    try {
        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            log.warning(`Import callback for company ${companyId} returned ${response.status}: ${text}`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warning(`Import callback POST failed for company ${companyId}: ${message}`);
    }
};
