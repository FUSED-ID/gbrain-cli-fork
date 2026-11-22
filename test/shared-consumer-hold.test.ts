import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimCoalescedGitEffects } from '../src/core/persistence/effect-journal.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { settleNoopEmbeddingEffects } from '../src/core/persistence/embedding-noop-settle.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimGroupFollowers, claimNextLaneHead, claimNextWrite, hasClaimableWrite } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const held = 'fixture-held';
const ordinary = 'fixture-held-sibling';
const env = { GBRAIN_WORKER_HELD_SOURCE: held };
const host = localHostId();
const backend = testBackends()[0]!;
let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
let engine: BrainEngine;

beforeAll(async () => { factory = await freshBrainFactory(backend, process.env.DATABASE_URL); }, 120_000);
beforeEach(async () => { engine = await factory.fresh(); }, 120_000);
afterAll(async () => { await factory?.dispose(); });

async function requestState(row: WriteRequest) {
  const [state] = await engine.executeRaw(
    'SELECT state, execution_token::text AS token, preparation_attempts, updated_at::text AS stamp FROM persistence_requests WHERE id=$1::uuid', [row.id]);
  return state;
}
async function effectState(row: WriteRequest, kind: string) {
  const [state] = await engine.executeRaw(
    'SELECT state, execution_token::text AS token, attempts, updated_at::text AS stamp FROM persistence_effects WHERE request_id=$1::uuid AND kind=$2', [row.id, kind]);
  return state;
}
async function worktree() {
  const [row] = await engine.executeRaw<{ id: string }>(
    'INSERT INTO persistence_worktrees(owner_host_id) VALUES($1::uuid) RETURNING id', [host]);
  return row!.id;
}
async function putAdmission(sourceId: string) {
  const fixture = await requestFixture(engine, sourceId);
  const prepared = await preparePageAdmission(fixture.ctx, { operation: 'put_page', params: {
    slug: 'notes/queued', content: '# Queued note\n\nFixture body.', request_id: randomUUID(), no_embed: true,
  } });
  return admitWrite(engine, prepared.admission!);
}
async function addEffect(row: WriteRequest, kind: 'embedding' | 'git', options: { worktree?: string; revision?: string; data?: object } = {}) {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,source_id,source_incarnation,worktree_id,revision,data,next_attempt_at)
      VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::text::jsonb,now()) ON CONFLICT(request_id,kind) DO UPDATE
      SET state='queued', data=EXCLUDED.data, revision=EXCLUDED.revision, next_attempt_at=EXCLUDED.next_attempt_at`,
    [row.id, kind, row.source_id, row.source_incarnation, options.worktree ?? null, options.revision ?? null, JSON.stringify(options.data ?? {})]);
  });
}

test('native consumer publishes ordinary admission while held admission stays queued, then resumes it', async () => {
  const pending = await putAdmission(held);
  const before = await requestState(pending);
  const ready = await putAdmission(ordinary);
  const cfg = { engine: engine.kind, embedding_disabled: true };
  try {
    await withEnv(env, async () => {
      const committed = await waitForWrite(engine, ready, cfg, 10_000);
      expect(committed.state).toBe('committed');
      expect(await requestState(pending)).toEqual(before);
      expect(await engine.getPage(pending.slug, { sourceId: held })).toBeNull();
      expect(await hasClaimableWrite(engine, host)).toBe(false);
      expect(await claimNextWrite(engine, host)).toBeNull();
    });
    await disposePersistenceConsumer(engine);
    expect((await waitForWrite(engine, pending, cfg, 10_000)).state).toBe('committed');
    expect(await engine.getPage(pending.slug, { sourceId: held })).not.toBeNull();
  } finally { await disposePersistenceConsumer(engine); }
}, 30_000);

test('a held journal follower ends the publication group at the FIFO boundary', async () => {
  const h = await requestFixture(engine, held);
  const o = await requestFixture(engine, ordinary);
  const root = await worktree();
  const head = await o.admit('head');
  const first = await o.admit('first');
  const blocked = await h.admit('held');
  const last = await o.admit('last');
  for (const row of [head, first, blocked, last]) {
    await editRequest(engine, row.id, "worktree_id=$2::uuid, intent=intent||'{\"page_batch\":{\"id\":\"group\"}}'::jsonb", [root]);
  }
  const claimed = (await claimNextWrite(engine, host))!;
  expect(claimed.id).toBe(head.id);
  const before = await requestState(blocked);
  await withEnv(env, async () => {
    expect((await claimGroupFollowers(engine, claimed, 'batch:group', 8)).map(row => row.id)).toEqual([first.id]);
    expect(await requestState(blocked)).toEqual(before);
    expect((await requestState(last))?.state).toBe('queued');
  });
  for (const row of [head, first]) await editRequest(engine, row.id, "state='cancelled', execution_token=NULL");
  expect((await claimNextWrite(engine, host))?.id).toBe(blocked.id);
}, 30_000);

test('managed sync lane claim skips the held root and claims an ordinary lane head', async () => {
  const candidates: Array<{ row: WriteRequest; root: string }> = [];
  for (const sourceId of [held, ordinary]) {
    const fixture = await requestFixture(engine, sourceId);
    const row = await fixture.admit('head');
    const root = await worktree();
    await editRequest(engine, row.id, "worktree_id=$2::uuid, intent=jsonb_build_object('kind','managed_sync_group','lane','fixture-lane','group',request_id::text)", [root]);
    candidates.push({ row, root });
  }
  const [blocked, allowed] = candidates;
  const before = await requestState(blocked!.row);
  await withEnv(env, async () => {
    expect(await claimNextLaneHead(engine, host, blocked!.root, 'fixture-lane')).toBeNull();
    expect((await claimNextLaneHead(engine, host, allowed!.root, 'fixture-lane'))?.id).toBe(allowed!.row.id);
    expect(await requestState(blocked!.row)).toEqual(before);
  });
  expect((await claimNextLaneHead(engine, host, blocked!.root, 'fixture-lane'))?.id).toBe(blocked!.row.id);
}, 30_000);

test('native effect worker gives its first slot to ordinary queued work and later resumes the held effect', async () => {
  const pending = await (await requestFixture(engine, held)).admit('held');
  const allowed = await (await requestFixture(engine, ordinary)).admit('allowed');
  await addEffect(pending, 'embedding');
  await addEffect(allowed, 'embedding');
  const before = await effectState(pending, 'embedding');
  const pass = () => runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true }, { hostId: host, limit: 1 });
  await withEnv(env, async () => {
    expect(await pass()).toBe(1);
    expect(await effectState(allowed, 'embedding')).toMatchObject({ state: 'committed', attempts: 1 });
    expect(await effectState(pending, 'embedding')).toEqual(before);
    expect(await pass()).toBe(0);
  });
  expect(await pass()).toBe(1);
  expect(await effectState(pending, 'embedding')).toMatchObject({ state: 'committed', attempts: 1 });
}, 30_000);

test('coalesced Git effect claims exclude a held effect before the batch limit', async () => {
  const root = await worktree();
  const pending = await (await requestFixture(engine, held)).admit('held');
  const allowed = await (await requestFixture(engine, ordinary)).admit('allowed');
  await addEffect(pending, 'git', { worktree: root, data: { relative_path: 'held.md' } });
  await addEffect(allowed, 'git', { worktree: root, data: { relative_path: 'ordinary.md' } });
  const before = await effectState(pending, 'git');
  await withEnv(env, async () => {
    expect((await claimCoalescedGitEffects(engine, host, root, 1)).map(row => row.request_id)).toEqual([allowed.id]);
    expect(await effectState(pending, 'git')).toEqual(before);
  });
  expect((await claimCoalescedGitEffects(engine, host, root, 1)).map(row => row.request_id)).toEqual([pending.id]);
}, 30_000);

test('embedding no-op settlement excludes held effects before its batch limit and resets after unhold', async () => {
  const signature = 'test:model:1536';
  const rows = [];
  for (const sourceId of [held, ordinary]) {
    const fixture = await requestFixture(engine, sourceId);
    const row = await fixture.admit('notes/page');
    await fixture.publish(row);
    const [page] = await engine.executeRaw<{ id: number; revision: string }>(
      'UPDATE pages SET text_projection_revision=knowledge_revision, embedding_signature=$2 WHERE source_id=$1 RETURNING id, knowledge_revision::text AS revision', [sourceId, signature]);
    await addEffect(row, 'embedding', { revision: page!.revision, data: { page_id: page!.id } });
    rows.push(row);
  }
  const [pending, allowed] = rows;
  const before = await effectState(pending!, 'embedding');
  const heldPass = await withEnv(env, async () => {
    const pass = await settleNoopEmbeddingEffects(engine, host, signature, undefined, 1);
    expect(pass.settled).toBe(1);
    expect(await effectState(allowed!, 'embedding')).toMatchObject({ state: 'committed', attempts: 1 });
    expect(await effectState(pending!, 'embedding')).toEqual(before);
    return pass;
  });
  const resumed = await settleNoopEmbeddingEffects(engine, host, signature, heldPass.cursor, 1);
  expect(resumed.settled).toBe(1);
  expect(await effectState(pending!, 'embedding')).toMatchObject({ state: 'committed', attempts: 1 });
}, 30_000);
