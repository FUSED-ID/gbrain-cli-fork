import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { drainPgliteQueue, runJobsWork } from '../src/commands/jobs/work.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { WORKER_EXIT_CONFIGURATION } from '../src/core/minions/worker-exit-codes.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  home = mkdtempSync(join(tmpdir(), 'gbrain-worker-only-'));
});

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

async function count(name: string, status: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM minion_jobs WHERE name = $1 AND status = $2',
    [name, status],
  );
  return Number(row?.n ?? 0);
}

describe('jobs work PGLite worker allow-list runtime', () => {
  test('claims only names selected by the allow-list', () => inHome(async () => {
    const queue = new MinionQueue(engine);
    await queue.ensureSchema();
    await queue.add('allowed-name', {}, {});
    await queue.add('excluded-name', {}, {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const drainWithAllowList = drainPgliteQueue as (...args: any[]) => Promise<{ delayed: number }>;
      const out = await drainWithAllowList(
        engine,
        queue,
        'default',
        async (worker: MinionWorker) => {
          worker.register('allowed-name', async () => ({ ok: true }));
          worker.register('excluded-name', async () => ({ ok: true }));
        },
        ['allowed-name'],
      );
      expect(out.delayed).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(await count('allowed-name', 'completed')).toBe(1);
    expect(await count('excluded-name', 'waiting')).toBe(1);
  }), 60_000);

  test('R5 rejects unknown names before draining and leaves seeded jobs waiting', () => inHome(async () => {
    const queue = new MinionQueue(engine);
    await queue.ensureSchema();
    await queue.add('allowed-name', {}, {});
    await queue.add('excluded-name', {}, {});
    const drainWithAllowList = drainPgliteQueue as (...args: any[]) => Promise<{ delayed: number }>;
    await expect(drainWithAllowList(
      engine,
      queue,
      'default',
      async (worker: MinionWorker) => {
        worker.register('allowed-name', async () => ({ ok: true }));
        worker.register('excluded-name', async () => ({ ok: true }));
      },
      ['typo-name'],
    )).rejects.toThrow('typo-name');
    expect(await count('allowed-name', 'waiting')).toBe(1);
    expect(await count('excluded-name', 'waiting')).toBe(1);
  }), 60_000);

  test('R9 jobs command entry drains only the selected built-in handler', () => inHome(async () => {
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const queue = new MinionQueue(engine);
      await queue.ensureSchema();
      await queue.add('shell', { cmd: 'true', cwd: '/tmp' }, {}, { allowProtectedSubmit: true });
      await queue.add('repair-jsonb', { dryRun: true }, {});
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runJobs(engine, ['work', '--only', 'shell']);
      } finally {
        log.mockRestore();
      }
      expect(await count('shell', 'completed')).toBe(1);
      expect(await count('repair-jsonb', 'waiting')).toBe(1);
    });
  }), 60_000);

  test('R10 MinionWorker start and stop claim only the selected handler', () => inHome(async () => {
    const queue = new MinionQueue(engine);
    await queue.ensureSchema();
    await queue.add('allowed-name', {}, {});
    await queue.add('excluded-name', {}, {});
    let resolveCompleted!: () => void;
    const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0 });
    worker.register('allowed-name', async () => {
      resolveCompleted();
      return { ok: true };
    });
    worker.register('excluded-name', async () => ({ ok: true }));
    worker.keepOnly(['allowed-name']);
    const running = worker.start();
    await completed;
    worker.stop();
    await running;
    expect(await count('allowed-name', 'completed')).toBe(1);
    expect(await count('excluded-name', 'waiting')).toBe(1);
  }), 60_000);

  test('R10 jobs work honors the environment allow-list through the command entry', () => inHome(async () => {
    const queue = new MinionQueue(engine);
    await queue.ensureSchema();
    await queue.add('shell', { cmd: 'true', cwd: '/tmp' }, {}, { allowProtectedSubmit: true });
    await queue.add('repair-jsonb', { dryRun: true }, {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_WORKER_ONLY_NAMES: 'shell', GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
        await runJobs(engine, ['work']);
      });
    } finally {
      log.mockRestore();
    }
    expect(await count('shell', 'completed')).toBe(1);
    expect(await count('repair-jsonb', 'waiting')).toBe(1);
  }), 60_000);

  test('R22 unknown worker-only names refuse before Postgres readiness or recovery', async () => {
    const startupCalls: string[] = [];
    const fakeEngine = {
      kind: 'postgres',
      executeRaw: async () => {
        startupCalls.push('readiness');
        throw new Error('readiness must not run for invalid worker selection');
      },
    };
    const fakeQueue = {
      ensureSchema: async () => { startupCalls.push('schema'); },
      reconcileOrphanedPrivateQueues: async () => { startupCalls.push('recovery'); return { cancelled_jobs: 0, cancelled_queues: 0 }; },
    };
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`TEST_EXIT:${exitCode}`);
    }) as never);
    try {
      await withEnv({ GBRAIN_WORKER_ONLY_NAMES: 'typo-name' }, async () => {
        try {
          await runJobsWork({ args: [], engine: fakeEngine, queue: fakeQueue } as never);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('TEST_EXIT:')) throw error;
        }
      });
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitCode).toBe(WORKER_EXIT_CONFIGURATION);
    expect(startupCalls).toEqual([]);
  });
});
