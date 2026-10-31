/**
 * A world withdrawal or purge must still refuse the same claim when a privacy
 * floor contracts an explicit world remember to private. The stored row, when
 * a different claim is saved, keeps the floored visibility.
 *
 * Setup follows test/p4-source-floor.test.ts (federated world source, private
 * frontmatter) and test/managed-facts-withdrawal-recovery-6506.test.ts
 * (recordFactWithdrawal of a world fact). Purge rows follow the 6506 skip seed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { FACT_WITHDRAWN_MESSAGE, recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';

const SOURCE = 'p4b-identity-fed';
const WITHDRAWN = 'the launch date moved to 2026-11-04';
const PURGED = 'the launch review moved to 2026-11-18';
const PRIVATE_ONLY = 'the public page claim was withdrawn only at private';
const UNRELATED = 'the rehearsal room is booked for tuesday';

let engine: PGLiteEngine;

const ctx = (): OperationContext => ({
  engine, remote: false, sourceId: SOURCE, config: { engine: engine.kind }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} },
});

async function putPage(slug: string, visibility: 'world' | 'private') {
  await engine.transaction(tx => withCoordinatedWrite(tx, [SOURCE], () => tx.putPage(slug, {
    type: 'note', title: slug, compiled_truth: 'page body', timeline: '',
    frontmatter: { visibility },
  }, { sourceId: SOURCE }), TEST_WRITE_ATTRIBUTION));
}

async function active(fact: string) {
  return engine.executeRaw<{ visibility: string }>(
    'SELECT visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id',
    [SOURCE, fact],
  );
}

async function remember(slug: string, fact: string) {
  return submitRememberMutation(ctx(), {
    fact, entity: slug, provenance: 'test', visibility: 'world', request_id: randomUUID(),
  }, 30_000);
}

async function rememberDefaulted(slug: string, fact: string) {
  return submitRememberMutation(ctx(), {
    fact, entity: slug, provenance: 'test', request_id: randomUUID(),
  }, 30_000, { visibilityDefaulted: true });
}

async function putPrivacyMarked(slug: string) {
  await engine.transaction(tx => withCoordinatedWrite(tx, [SOURCE], () => tx.putPage(slug, {
    type: 'note', title: slug, compiled_truth: 'page body', timeline: '',
    frontmatter: { access: 'private' },
  }, { sourceId: SOURCE }), TEST_WRITE_ATTRIBUTION));
}

async function unmanaged<T>(body: () => Promise<T>): Promise<T> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    return await body();
  } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}

async function seedWorldWithdrawal(slug: string, fact: string) {
  await putPage(slug, 'world');
  const saved = await unmanaged(() => engine.insertFact({
    fact, entity_slug: slug, visibility: 'world', kind: 'fact', source: 'fixture',
  }, { source_id: SOURCE }));
  const result = await unmanaged(() => recordFactWithdrawal(engine, saved.id, SOURCE, false, { semanticReview: false }));
  expect(result.withdrawn).toBe(true);
  const [row] = await engine.executeRaw<{ visibility: string }>(
    `SELECT visibility FROM fact_withdrawals WHERE source_id=$1 AND subject=$2 AND fact_hash=gbrain_fact_fingerprint($3)`,
    [SOURCE, slug, fact],
  );
  expect(row?.visibility).toBe('world');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await registerLocalWriter(engine, 'cli');
  await registerLocalWriter(engine, 'stdio');
  await engine.setConfig('embedding_disabled', 'true');
  await engine.setConfig('sync.write_through', 'false');
  await engine.executeRaw(
    'INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)',
    [SOURCE, JSON.stringify({ federated: true, facts_visibility: 'world' })],
  );
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine?.disconnect();
});

describe('P4 withdrawal identity when a floor forces world to private', () => {
  test('1 world withdrawal, then a private page, refuses explicit world remember', async () => {
    const slug = 'notes/p4b-world-withdrawn';
    await seedWorldWithdrawal(slug, WITHDRAWN);
    await putPage(slug, 'private');
    const error = await remember(slug, WITHDRAWN).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
    expect(FACT_WITHDRAWN_MESSAGE.startsWith('fact_withdrawn')).toBe(true);
    expect(await active(WITHDRAWN)).toEqual([]);
  }, 60_000);

  test('2 world purge, then a private page, refuses explicit world remember', async () => {
    const slug = 'notes/p4b-world-purged';
    await putPage(slug, 'world');
    await engine.executeRaw(
      `INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,actor,reason)
       VALUES($1,'world',$2,gbrain_fact_fingerprint($3),'fixture','regression') ON CONFLICT DO NOTHING`,
      [SOURCE, slug, PURGED],
    );
    await putPage(slug, 'private');
    const error = await remember(slug, PURGED).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'purged_content' });
    expect(error instanceof Error && error.message.includes('purged_content')).toBe(true);
    expect(await active(PURGED)).toEqual([]);
  }, 60_000);

  test('3 a private-only withdrawal does not block explicit world remember on a public page', async () => {
    const slug = 'notes/p4b-public-control';
    await putPage(slug, 'world');
    const saved = await unmanaged(() => engine.insertFact({
      fact: PRIVATE_ONLY, entity_slug: slug, visibility: 'private', kind: 'fact', source: 'fixture',
    }, { source_id: SOURCE }));
    const result = await unmanaged(() => recordFactWithdrawal(engine, saved.id, SOURCE, false, { semanticReview: false }));
    expect(result.withdrawn).toBe(true);
    const [row] = await engine.executeRaw<{ visibility: string }>(
      `SELECT visibility FROM fact_withdrawals WHERE source_id=$1 AND subject=$2 AND fact_hash=gbrain_fact_fingerprint($3)`,
      [SOURCE, slug, PRIVATE_ONLY],
    );
    expect(row?.visibility).toBe('private');
    const remembered = await remember(slug, PRIVATE_ONLY);
    expect(remembered.status).toBe('inserted');
    expect(await active(PRIVATE_ONLY)).toEqual([{ visibility: 'world' }]);
  }, 60_000);

  test('4 an unrelated claim on the private page is saved as private', async () => {
    const slug = 'notes/p4b-unrelated-private';
    await putPage(slug, 'private');
    const remembered = await remember(slug, UNRELATED);
    expect(remembered.status).toBe('inserted');
    expect(await active(UNRELATED)).toEqual([{ visibility: 'private' }]);
  }, 60_000);

  test('e brain default world, privacy-marked page, refuses a defaulted remember of a withdrawn world claim', async () => {
    const slug = 'notes/p4b-defaulted-withdrawn';
    const fact = 'the launch window moved to 2026-12-02';
    await engine.setConfig('facts.default_visibility', 'world');
    await seedWorldWithdrawal(slug, fact);
    await putPrivacyMarked(slug);
    const error = await rememberDefaulted(slug, fact).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
    expect(await active(fact)).toEqual([]);
  }, 60_000);

  test('f a world withdrawal recorded after admission is refused at publication', async () => {
    const slug = 'notes/p4b-defaulted-late-withdrawal';
    const fact = 'the rehearsal moved to wednesday evening';
    await engine.setConfig('facts.default_visibility', 'world');
    await putPrivacyMarked(slug);
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:prepared' || detail.operation !== 'remember' || detail.sourceId !== SOURCE) return;
      await engine.executeRaw(
        `INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
         VALUES($1,'world',$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING`,
        [SOURCE, slug, fact],
      );
    });
    try {
      const error = await rememberDefaulted(slug, fact).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
      expect(await active(fact)).toEqual([]);
    } finally {
      installFaultHook(undefined);
    }
  }, 60_000);

  test('g a world remember admitted on a public federated page, the page then turned private, then a world withdrawal, refuses at publication', async () => {
    const slug = 'notes/p4b-admitted-then-private';
    const fact = 'the launch date moved to 2026-11-21';
    await putPage(slug, 'world');
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:preparing' || detail.operation !== 'remember' || detail.sourceId !== SOURCE) return;
      await putPage(slug, 'private');
      await engine.executeRaw(
        `INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
         VALUES($1,'world',$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING`,
        [SOURCE, slug, fact],
      );
    });
    try {
      const error = await remember(slug, fact).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
      expect(await active(fact)).toEqual([]);
    } finally {
      installFaultHook(undefined);
    }
  }, 60_000);

  test('h a defaulted world remember contracted by a floor after admission refuses a world purge', async () => {
    const slug = 'notes/p4b-defaulted-contracted-purge';
    const fact = 'the launch review moved to 2026-12-09';
    await engine.setConfig('facts.default_visibility', 'world');
    await putPage(slug, 'world');
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:preparing' || detail.operation !== 'remember' || detail.sourceId !== SOURCE) return;
      await putPage(slug, 'private');
      await engine.executeRaw(
        `INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,actor,reason)
         VALUES($1,'world',$2,gbrain_fact_fingerprint($3),'fixture','regression') ON CONFLICT DO NOTHING`,
        [SOURCE, slug, fact],
      );
    });
    try {
      const error = await rememberDefaulted(slug, fact).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'purged_content' });
      expect(error instanceof Error && error.message.includes('purged_content')).toBe(true);
      expect(await active(fact)).toEqual([]);
    } finally {
      installFaultHook(undefined);
    }
  }, 60_000);
});
