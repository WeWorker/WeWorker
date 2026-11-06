import test from 'node:test';
import assert from 'node:assert/strict';
import { stopManagedServices } from '../managed-shutdown.js';

test('quit waits for both task services, including failure, before releasing the shared browser', async () => {
  let explorationDone, backendFailed;
  const events = [];
  const stopped = stopManagedServices({
    stopExploration: () => new Promise(resolve => { explorationDone = resolve; events.push('exploration'); }),
    stopBackend: () => new Promise((_resolve, reject) => { backendFailed = reject; events.push('backend'); }),
    stopBrowser: async () => { events.push('browser'); },
  });
  backendFailed(new Error('fixture shutdown failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['exploration', 'backend']);
  explorationDone();
  await stopped;
  assert.deepEqual(events, ['exploration', 'backend', 'browser']);
});
