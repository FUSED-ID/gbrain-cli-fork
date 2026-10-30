import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { createConnectorFixture, options, settleConnectorWrites } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

// P4 floors a privacy-marked page's fact to private while the fence cell still says world. A forget must
// still strike the row from the body, because the withdrawal ledger is matched at the floored visibility too.
const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(async () => { await setup(); }, 120_000);
afterAll(async () => { await teardown(); });
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN', federated: true };
const claim = 'floored1030sentinel prefers amber fixtures';
const ctx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const slug = 'notes/federated-floored-1030';
const content = `---\ntype: note\ntitle: Federated floored note\nvisibility: private\n---\n# Federated floored note\n\nKeep this exact prose.\n${renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }])}\n`;

test('forgetting a fact on a privacy-marked page strikes it from the body even when its fence cell says world', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => {
      await managed!.importMarkdown(`${slug}.md`, content);
    });
    await settleConnectorWrites(engine, f.id);
    const [fact] = await engine.executeRaw<{ id: number; visibility: string }>('SELECT id,visibility FROM facts WHERE source_id=$1 ORDER BY id LIMIT 1', [f.id]);
    expect(fact.visibility).toBe('private');
    const before = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(before.page.compiled_truth).toContain(claim);
    await submitForgetMutation(ctx(engine, f.id), 'forget_fact', { id: Number(fact.id) });
    await disposePersistenceConsumer(engine);
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 100 });
    const final = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(sanitizeRemoteBody(final.page.compiled_truth)).not.toContain(claim);
    expect(final.page.compiled_truth).toContain('Keep this exact prose.');
  }
}), 120_000);
