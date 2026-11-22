import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runCompactionPass } from '../src/core/persistence/compaction-pass.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { sweepSegmentStorage } from '../src/core/persistence/journal.ts';
import { publicationConcurrency } from '../src/core/persistence/pool-capacity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const held = 'fixture-held';
const ordinary = 'fixture-held-sibling';
const env = { GBRAIN_WORKER_HELD_SOURCE: held };
const backend = testBackends()[0]!;
const host = localHostId();

async function fresh(run: (engine: BrainEngine) => Promise<void>) {
  const factory = await freshBrainFactory(backend, process.env.DATABASE_URL);
  try { await run(await factory.fresh()); }
  finally { await factory.dispose(); }
}

test('resident segment GC preserves held unreferenced text and collects ordinary text', () => fresh(async engine => {
  for (const source of [held, ordinary]) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
    await engine.executeRaw(`INSERT INTO page_segment_texts(source_id,sha256,byte_len,line_count,body,created_at)
      VALUES($1,decode(repeat('ab',32),'hex'),1,1,decode('61','hex'),now()-interval '100 days')`, [source]);
  }
  const sources = () => engine.executeRaw('SELECT source_id FROM page_segment_texts ORDER BY source_id');
  await withEnv(env, () => sweepSegmentStorage(engine));
  expect(await sources()).toEqual([{ source_id: held }]);
  await sweepSegmentStorage(engine);
  expect(await sources()).toEqual([]);
}), 30_000);

test('resident receipt compaction leaves held pending requests and effects untouched', () => fresh(async engine => {
  const h = await requestFixture(engine, held);
  const o = await requestFixture(engine, ordinary);
  const heldEffect = await h.admit('notes/held-effect');
  await h.publish(heldEffect);
  const oldOrdinary = await o.admit('notes/ordinary-terminal');
  await o.publish(oldOrdinary);
  const heldRequest = await h.admit('notes/held-request');
  await editRequest(engine, oldOrdinary.id, "completed_at=now()-interval '5 years'");
  await editRequest(engine, heldEffect.id, "completed_at=now()-interval '5 years'");
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id=$1::uuid", [oldOrdinary.id]);
  });
  const snapshot = () => Promise.all([
    engine.executeRaw('SELECT to_jsonb(r)::text AS row FROM persistence_requests r WHERE source_id=$1 ORDER BY sequence', [held]),
    engine.executeRaw('SELECT to_jsonb(e)::text AS row FROM persistence_effects e WHERE source_id=$1 ORDER BY id', [held]),
  ]);
  const before = await snapshot();
  expect(before[0]).toHaveLength(2);
  expect(before[1].length).toBeGreaterThan(0);
  expect((await withEnv(env, () => runCompactionPass(engine, { hostId: host }))).compacted).toBe(1);
  expect(await snapshot()).toEqual(before);
  expect(await engine.executeRaw('SELECT compacted FROM persistence_requests WHERE id=$1::uuid', [oldOrdinary.id])).toEqual([{ compacted: true }]);
  expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE id=$1::uuid', [heldRequest.id])).toEqual([{ state: 'queued' }]);
}), 30_000);

if (backend === 'postgres') {
  test('a real capacity-zero consumer marks only ordinary queued requests', async () => {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const worker = new PostgresEngine();
    try {
      const h = await requestFixture(fixture.engine, held);
      const o = await requestFixture(fixture.engine, ordinary);
      const pending = await h.admit('notes/held');
      const normal = await o.admit('notes/ordinary');
      const read = (id: string) => fixture.engine.executeRaw('SELECT state,blocked_reason FROM persistence_requests WHERE id=$1::uuid', [id]);
      await worker.connect({ database_url: fixture.databaseUrl, poolSize: 1 });
      expect(publicationConcurrency(worker)).toBe(0);
      const faults: unknown[] = [];
      const consumer = new PersistenceConsumer(worker, { engine: 'postgres' },
        async () => { throw new Error('no capacity to publish'); }, { hostId: host, onError: error => faults.push(error) });
      try { await withEnv(env, () => consumer.tick()); }
      finally { await consumer.stop(); }
      expect(faults).toEqual([]);
      expect(await read(normal.id)).toEqual([{ state: 'queued', blocked_reason: 'writer_pool_capacity' }]);
      expect(await read(pending.id)).toEqual([{ state: 'queued', blocked_reason: null }]);
    } finally { await worker.disconnect(); await fixture.close(); }
  }, 30_000);
}
