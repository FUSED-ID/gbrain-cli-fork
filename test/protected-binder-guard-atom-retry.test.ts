/**
 * LOW 6 (Fable 2026-11-24): an explicit atom retry of a batch from a protected
 * Binder page is skipped with protected_binder_page and calls no model; with
 * GBRAIN_PROTECTED_BINDER_GUARD=off the same retry reruns the model as before.
 * Harness copied from managed-atoms-retry.test.ts.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const GUARD = 'GBRAIN_PROTECTED_BINDER_GUARD';
const BINDER = 'docs/binder-gbrain-conops-doc-family-2026-11-24-t4';
const VALID = JSON.stringify([{ title: 'Measured progress', atom_type: 'insight', body: 'Measure progress against clear exit criteria.' }]);

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); resetGateway(); });

function fixture() {
  const replies: string[] = [];
  let calls = 0;
  const chat = async (): Promise<ChatResult> => {
    calls++;
    return { text: replies.shift() ?? 'not valid output', blocks: [], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { replies, chat, calls: () => calls };
}
const setManaged = (on: boolean) => engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [on]);
const atomCount = async () => (await engine.executeRaw("SELECT id FROM pages WHERE type='atom' AND deleted_at IS NULL")).length;

async function failedBatch(home: string) {
  await setManaged(false);
  const page = await engine.putPage(BINDER, { type: 'note', title: 'Binder', compiled_truth: 'A careful project record. '.repeat(40) }, { sourceId: 'default' });
  await setManaged(true);
  const f = fixture();
  await withEnv({ GBRAIN_HOME: home, [GUARD]: 'off' }, () => runPhaseExtractAtoms(engine, { _transcripts: [],
    _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: f.chat }));
  await disposePersistenceConsumer(engine);
  expect(f.calls()).toBe(1);
  const [row] = await engine.executeRaw<{ request_id: string }>(
    "SELECT completed_keys->0->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'requestId' IS NOT NULL LIMIT 1");
  expect(row?.request_id).toBeTruthy();
  return { requestId: row.request_id, f };
}

for (const guard of ['on', 'off'] as const) test(`explicit atom retry of a Binder batch, guard ${guard}`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bg3-atom-retry-'));
  try {
    const { requestId, f } = await failedBatch(home);
    f.replies.push(VALID);
    __setChatTransportForTests(f.chat);
    const result = await withEnv({ GBRAIN_HOME: home, [GUARD]: guard === 'off' ? 'off' : undefined },
      () => retryManagedAtomBatch(engine, 'default', requestId, `job:bg3-${guard}`));
    if (guard === 'on') {
      expect(result).toMatchObject({ status: 'skipped', skipped: 'protected_binder_page', slug: BINDER });
      expect(f.calls()).toBe(1);
      expect(await atomCount()).toBe(0);
    } else {
      expect(result).toMatchObject({ model_rerun: true });
      expect(f.calls()).toBe(2);
    }
  } finally {
    __setChatTransportForTests(null);
    await stopPersistenceConsumer(engine);
    await setManaged(false);
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
