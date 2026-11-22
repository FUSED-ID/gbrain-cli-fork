import { expect, test } from 'bun:test';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

test('a queued legacy effect inherits its held source from the parent request', async () => {
  const backend = testBackends()[0]!;
  const factory = await freshBrainFactory(backend, process.env.DATABASE_URL);
  try {
    const engine = await factory.fresh();
    const heldSource = 'fixture-held';
    const h = await requestFixture(engine, heldSource);
    const o = await requestFixture(engine, 'fixture-held-sibling');
    const held = await h.admit('held');
    const ordinary = await o.admit('ordinary');
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation)
        VALUES($1::uuid,'embedding','{}',NULL,NULL),($2::uuid,'embedding','{}',$3,$4::uuid)`,
      [held.id, ordinary.id, ordinary.source_id, ordinary.source_incarnation]);
    });
    await withEnv({ GBRAIN_WORKER_HELD_SOURCE: heldSource }, async () => {
      expect((await claimPersistenceEffect(engine, localHostId()))?.request_id).toBe(ordinary.id);
      expect(await engine.executeRaw('SELECT state,attempts FROM persistence_effects WHERE request_id=$1::uuid', [held.id]))
        .toEqual([{ state: 'queued', attempts: 0 }]);
    });
  } finally { await factory.dispose(); }
}, 30_000);
