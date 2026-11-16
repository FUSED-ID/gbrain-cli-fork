import { describe, expect, mock, test } from 'bun:test';

const realLanes = await import('../src/core/minions/lanes.ts');

const registrationOptions: Array<{ quiet?: boolean; config?: { engine?: string } } | undefined> = [];
const stopAfterRuntimeRegistration = new Error('stop after capturing selected handler registration');

mock.module('../src/commands/jobs.ts', () => ({
  parseWorkerOnlyNames: () => ['subagent'],
  registerBuiltinHandlers: async (worker: { register: (name: string, handler: () => Promise<void>) => void }, _engine: unknown, opts?: { quiet?: boolean; config?: { engine?: string } }) => {
    registrationOptions.push(opts);
    worker.register('subagent', async () => {});
    if (registrationOptions.length === 2) throw stopAfterRuntimeRegistration;
  },
}));

mock.module('../src/commands/jobs-readiness.ts', () => ({
  checkWorkerStartup: async () => ({}),
  reportWorkerConfiguration: () => {},
  reportWorkerReady: () => {},
  reportWorkerStarting: () => {},
}));

mock.module('../src/core/minions/lanes.ts', () => ({
  ...realLanes,
  resolveLanePolicy: async () => ({ longJobNames: [], shortJobReservedSlots: 0 }),
}));

const { runJobsWork } = await import('../src/commands/jobs/work.ts');

describe('Postgres selected worker configuration', () => {
  test('preserves full config loading for the selected subagent handler', async () => {
    registrationOptions.length = 0;
    const previous = {
      GBRAIN_WORKER_ONLY_NAMES: process.env.GBRAIN_WORKER_ONLY_NAMES,
      GBRAIN_SUPERVISED: process.env.GBRAIN_SUPERVISED,
      GBRAIN_HOME: process.env.GBRAIN_HOME,
    };
    process.env.GBRAIN_WORKER_ONLY_NAMES = 'subagent';
    process.env.GBRAIN_SUPERVISED = '1';
    process.env.GBRAIN_HOME = '/tmp/gbrain-worker-config-parity-test';
    const engine = { kind: 'postgres' };
    const queue = { ensureSchema: async () => {}, reconcileOrphanedPrivateQueues: async () => ({ cancelled_jobs: 0, cancelled_queues: 0 }) };
    try {
      await expect(runJobsWork({ args: [], engine, queue } as never)).rejects.toBe(stopAfterRuntimeRegistration);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    // Fork worker design (840492660a, R22 8426323c): the name probe registers quietly with the real config and the
    // live worker registers with no options, so no registration ever carries an injected (synthetic) config and the
    // selected subagent handler keeps full config loading.
    expect(registrationOptions).toHaveLength(2);
    expect(registrationOptions[0]).toEqual({ quiet: true });
    expect(registrationOptions[1]).toBeUndefined();
    expect(registrationOptions.every((o) => o?.config === undefined)).toBe(true);
  });
});
