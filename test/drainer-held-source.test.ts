import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

const engine = new PGLiteEngine();
const queue = new MinionQueue(engine);
beforeAll(async () => {
  await engine.connect({});
  await engine.initSchema();
  await queue.ensureSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('held-source work and an unscoped drain remain waiting while an ordinary source can run', async () => {
  const held = 'fused-id-infrastructure';
  const names = ['chronicle_extract', 'extract-atoms-drain'];
  const prior = process.env.GBRAIN_WORKER_HELD_SOURCE;
  process.env.GBRAIN_WORKER_HELD_SOURCE = held;
  try {
    const protectedJob = await queue.add('chronicle_extract', {sourceId: held, slug: 'binder'}, {});
    const bulkJob = await queue.add('extract-atoms-drain', {}, {}, {allowProtectedSubmit: true});
    const ordinaryJob = await queue.add('chronicle_extract', {sourceId: 'default', slug: 'office'}, {});
    const claimed = await queue.claim('fixture-first', 60000, 'default', names);
    expect(claimed?.id).toBe(ordinaryJob.id);
    expect(await queue.claim('fixture-next', 60000, 'default', names)).toBeNull();
    for (const job of [protectedJob, bulkJob]) {
      const [row] = await engine.executeRaw<{status:string; attempts_started:number}>(
        'SELECT status, attempts_started FROM minion_jobs WHERE id = $1', [job.id]);
      expect(row.status).toBe('waiting');
      expect(Number(row.attempts_started)).toBe(0);
    }
    delete process.env.GBRAIN_WORKER_HELD_SOURCE;
    expect((await queue.claim('fixture-unheld', 60000, 'default', names))?.id).toBe(protectedJob.id);
  } finally {
    if (prior === undefined) delete process.env.GBRAIN_WORKER_HELD_SOURCE;
    else process.env.GBRAIN_WORKER_HELD_SOURCE = prior;
  }
});
