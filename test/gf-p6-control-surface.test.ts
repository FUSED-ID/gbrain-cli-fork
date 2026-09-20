import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('gf-p6 part (a): purge-gated names are gated at claim', () => {
  test('a protected row inserted directly into the queue is not claimed', async () => {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, queue, status, data)
       VALUES ('purge', 'default', 'waiting', '{}'::jsonb)
       RETURNING id`,
    );
    expect(rows).toHaveLength(1);

    const claimed = await queue.claim('gf-p6-direct', 30_000, 'default', ['purge']);

    expect(claimed).toBeNull();
    const remaining = await queue.getJob(rows[0].id);
    expect(remaining?.status).toBe('waiting');
  });

  test('an explicit protected submit remains claimable and worker narrowing remains exact', async () => {
    const deliberate = await queue.add(
      'purge',
      { scope: 'pages' },
      undefined,
      { allowProtectedSubmit: true },
    );
    await queue.add('chronicle_extract', {});
    await queue.add('facts-absorb', {});

    const claim = await queue.claim(
      'gf-p6-deliberate',
      30_000,
      'default',
      ['purge', 'chronicle_extract'],
    );

    expect(claim?.id).toBe(deliberate.id);
    expect(claim?.name).toBe('purge');
    expect(claim?.data).toEqual({ scope: 'pages' });

    const next = await queue.claim('gf-p6-only', 30_000, 'default', ['facts-absorb']);
    expect(next?.name).toBe('facts-absorb');
    const unclaimed = await queue.getJobs({ status: 'waiting' });
    expect(unclaimed.map((job) => job.name)).toEqual(['chronicle_extract']);
  });

  test('retry does not re-arm a protected job', async () => {
    const deliberate = await queue.add(
      'purge',
      {},
      undefined,
      { allowProtectedSubmit: true },
    );
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead' WHERE id = $1`,
      [deliberate.id],
    );

    expect(await queue.retryJob(deliberate.id)).toBeNull();
    const stillDead = await queue.getJob(deliberate.id);
    expect(stillDead?.status).toBe('dead');
  });
});

async function getHandler(
  name: string,
): Promise<(job: { id: number; data: Record<string, unknown>; signal?: AbortSignal }) => Promise<any>> {
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const handlers = (worker as unknown as {
    handlers: Map<string, (job: { id: number; data: Record<string, unknown>; signal?: AbortSignal }) => Promise<any>>;
  }).handlers;
  const handler = handlers.get(name);
  if (!handler) throw new Error(`handler not registered: ${name}`);
  return handler;
}

describe('gf-p6 part (b): queued autopilot cycles cannot reach purge', () => {
  test('autopilot-cycle excludes purge even when a queued payload requests only purge', async () => {
    const purgeCalls: number[] = [];
    const original = engine.purgeDeletedPages.bind(engine);
    engine.purgeDeletedPages = (async (hours: number) => {
      purgeCalls.push(hours);
      return { count: 0, slugs: [], pages: [] };
    }) as PGLiteEngine['purgeDeletedPages'];

    try {
      const handler = await getHandler('autopilot-cycle');
      const result = await handler({
        id: 1,
        data: { phases: ['purge'], repoPath: null },
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('skipped');
      expect(result.report.reason).toBe('all_phases_rejected_by_safety');
      expect(purgeCalls).toEqual([]);
    } finally {
      engine.purgeDeletedPages = original;
    }
  });

  test('global maintenance excludes purge from its queued phase list', async () => {
    const purgeCalls: number[] = [];
    const original = engine.purgeDeletedPages.bind(engine);
    engine.purgeDeletedPages = (async (hours: number) => {
      purgeCalls.push(hours);
      return { count: 0, slugs: [], pages: [] };
    }) as PGLiteEngine['purgeDeletedPages'];

    try {
      const handler = await getHandler('autopilot-global-maintenance');
      const result = await handler({
        id: 2,
        data: { phases: ['purge'], repoPath: null },
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('skipped');
      expect(result.report.reason).toBe('all_phases_rejected_by_safety');
      expect((result.report.phases ?? []).map((phase: { phase: string }) => phase.phase)).not.toContain('purge');
      expect(purgeCalls).toEqual([]);
    } finally {
      engine.purgeDeletedPages = original;
    }
  });
});
