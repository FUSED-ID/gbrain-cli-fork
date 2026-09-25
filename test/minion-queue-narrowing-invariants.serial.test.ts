// These invariants exist because the purge-set narrowing is deliberate: they
// prevent the ordinary claim and retry paths from being widened back out by
// accident while keeping purge rows gated.
import { beforeAll, afterAll, beforeEach, expect, test } from 'bun:test';
// v0.57 queue protocol 1: every inserted row carries a submission_authority
// (enforce_minion_queue_protocol trigger). "Grant-less" below still means no
// fork purge-claim grant in data; the rows use the application authority as
// upstream's own raw-insert fixtures do.
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
let engine: PGLiteEngine; let queue: MinionQueue;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ database_url: '' }); await engine.initSchema(); queue = new MinionQueue(engine); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

test('a grant-less waiting subagent row is claimable', async () => {
  await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, queue, status, data) VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent','default','waiting','{}'::jsonb)`);
  const c = await queue.claim('p1', 30_000, 'default', ['subagent']);
  expect(c?.name).toBe('subagent');
});
test('a grant-less waiting shell row is claimable', async () => {
  await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, queue, status, data) VALUES ('{"version":1,"kind":"application"}'::jsonb, 'shell','default','waiting','{}'::jsonb)`);
  const c = await queue.claim('p2', 30_000, 'default', ['shell']);
  expect(c?.name).toBe('shell');
});
test('a grant-less waiting purge row is not claimable', async () => {
  await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, queue, status, data) VALUES ('{"version":1,"kind":"application"}'::jsonb, 'purge','default','waiting','{}'::jsonb)`);
  expect(await queue.claim('p3', 30_000, 'default', ['purge'])).toBeNull();
});
test('a dead shell row is retryable via queue.retryJob', async () => {
  const r = await engine.executeRaw<{id:number}>(`INSERT INTO minion_jobs (submission_authority, name, queue, status, data) VALUES ('{"version":1,"kind":"application"}'::jsonb, 'shell','default','dead','{}'::jsonb) RETURNING id`);
  expect((await queue.retryJob(Number(r[0].id)))?.status).toBe('waiting');
});
