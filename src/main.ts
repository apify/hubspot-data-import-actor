import { Actor, log } from 'apify';

import { validateInput } from './validation.js';
import { runImport } from './orchestration.js';

await Actor.init();

try {
    const input = validateInput(await Actor.getInput());

    const store = await Actor.openKeyValueStore();
    const dataset = await Actor.openDataset(input.datasetId);

    await runImport({
        input,
        kv: {
            get: (key) => store.getValue(key),
            set: (key, value) => store.setValue(key, value),
        },
        dataset,
        pushData: (rows) => Actor.pushData(rows),
        setOutput: (output) => Actor.setValue('OUTPUT', output),
        onPersistEvent: (handler) => {
            Actor.on('migrating', () => {
                log.info('Migration event received, persisting state...');
                return handler();
            });
            Actor.on('persistState', () => handler());
        },
        failRun: (message) => Actor.fail(message),
        now: () => new Date(),
    });
} catch (err) {
    log.error('Import failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    await Actor.fail(errorMessage);
} finally {
    await Actor.exit();
}