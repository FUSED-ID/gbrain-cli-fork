/**
 * Explicit visibility vs a private page (473 seam: isDerivationPrivate).
 * Cases 1 and 2 use a federated source so the source clamp does not hide the page floor.
 * Case 2 passes explicit world with visibility_defaulted unset.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { prepareMemoryMutation, submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { isDerivationPrivate } from '../src/core/search/private-visibility.ts';

const PRIV = 'priv-explicit-1030';
const FED = 'fed-explicit-1030';
const PRIV_SLUG = 'people/priv-explicit-1030';
const FED_SLUG = 'people/fed-explicit-1030';
let engine: PGLiteEngine;

const ctx = (sourceId: string): OperationContext => ({
  engine, remote: false, sourceId, config: { engine: engine.kind }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} },
});

async function addSource(id: string): Promise<void> {
  await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)`,
    [id, JSON.stringify({ federated: true })],
  );
}

async function addPage(sourceId: string, slug: string, frontmatter: Record<string, unknown>): Promise<void> {
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage(slug, {
    type: 'person', title: slug, compiled_truth: 'biography', timeline: 'timeline', frontmatter,
  }, { sourceId }), TEST_WRITE_ATTRIBUTION));
}

async function stored(sourceId: string, fact: string): Promise<string> {
  const rows = await engine.executeRaw<{ visibility: string }>(
    'SELECT visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id DESC LIMIT 1',
    [sourceId, fact],
  );
  if (!rows[0]) throw new Error(`no fact row for ${fact} in ${sourceId}`);
  return rows[0].visibility;
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
  await addSource(PRIV);
  await addSource(FED);
  await addPage(PRIV, PRIV_SLUG, { visibility: 'private' });
  await addPage(FED, FED_SLUG, { visibility: 'world' });
  const priv = (await engine.readPageSnapshot(PRIV_SLUG, { sourceId: PRIV }))!;
  const fed = (await engine.readPageSnapshot(FED_SLUG, { sourceId: FED }))!;
  if (!isDerivationPrivate(priv.page)) throw new Error('harness: private page is not private to isDerivationPrivate');
  if (isDerivationPrivate(fed.page)) throw new Error('harness: control page is private to isDerivationPrivate');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine?.disconnect();
});

test('explicit world on a private page and a federated control', async () => {
  const failures: string[] = [];
  const check = async (n: number, want: string, run: () => Promise<string>) => {
    try {
      const got = await run();
      expect(got).toBe(want);
      console.log(`CASE ${n} PASS visibility=${got}`);
    } catch (error) {
      const message = error instanceof Error ? (error.message || String(error)) : String(error);
      failures.push(`CASE ${n} FAIL ${message}`);
      console.log(`CASE ${n} FAIL ${message}`);
    }
  };

  await check(1, 'private', async () => {
    const fact = 'case1 explicit world on private page';
    await submitRememberMutation(ctx(PRIV), {
      fact, entity: PRIV_SLUG, provenance: 'test', visibility: 'world', request_id: randomUUID(),
    }, 30_000);
    return stored(PRIV, fact);
  });

  await check(2, 'private', async () => {
    await disposePersistenceConsumer(engine);
    const fact = 'case2 memory-prepare explicit world on private page';
    const snapshot = (await engine.readPageSnapshot(PRIV_SLUG, { sourceId: PRIV }))!;
    const authority = await submissionAuthority(ctx(PRIV), 'remember', PRIV, snapshot.sourceIncarnation, PRIV_SLUG);
    const intent = {
      fact, provenance: 'test', entity_slug: PRIV_SLUG, visibility: 'world', fence: true,
      valid_from: new Date().toISOString(), valid_until: null,
    };
    await admitWrite(engine, {
      principal: authority.principal, operation: 'remember', sourceId: PRIV,
      sourceIncarnation: snapshot.sourceIncarnation, slug: PRIV_SLUG, pageId: snapshot.page.id,
      callerIntent: intent, intent, authority, requestId: randomUUID(),
    });
    const row = (await claimNextWrite(engine, randomUUID()))!;
    const prepared = await prepareMemoryMutation(engine as BrainEngine, row, ctx(PRIV).config);
    const published = await publishMutation(engine, row, prepared);
    if (published.state !== 'committed') {
      throw new Error(`publish ${published.state} ${published.error_code ?? ''} ${published.error_message ?? ''}`.trim());
    }
    return stored(PRIV, fact);
  });

  await check(3, 'world', async () => {
    const fact = 'case3 explicit world on federated page';
    await submitRememberMutation(ctx(FED), {
      fact, entity: FED_SLUG, provenance: 'test', visibility: 'world', request_id: randomUUID(),
    }, 30_000);
    return stored(FED, fact);
  });

  if (failures.length) throw new Error(failures.join('\n'));
}, 120_000);
