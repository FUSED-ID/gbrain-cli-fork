/**
 * Managed fence rendering must write the floored visibility it stores.
 *
 * A federated world source can still hold a page whose frontmatter visibility
 * is private. floorFactRows tightens an explicit world fact to private for
 * that page. The fence cell and the stored facts row must both say private.
 * A public page keeps world in both places.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { floorFactRows } from '../src/core/engine-sql/facts.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { withEnv } from './helpers/with-env.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-p4-fence-render-db-'));
const engine = new PGLiteEngine();
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };

beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: '{"facts":[]}', blocks: [], stopReason: 'end', usage,
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

function page(title: string, visibility: 'private' | 'world') {
  return `---\ntitle: ${title}\ntype: person\nvisibility: ${visibility}\n---\n# ${title}\n`;
}

function fenceVisibility(markdown: string, claim: string): string {
  const line = markdown.split('\n').find(row => row.includes(claim));
  if (!line) throw new Error(`fence row missing for ${claim}`);
  const cells = line.split('|').map(cell => cell.trim());
  return cells[5] ?? '';
}

async function managed(seed: (put: (slug: string, content: string) => Promise<void>) => Promise<void>,
  run: (fx: { sourceId: string; root: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-p4-fence-render-'));
  const root = join(dir, 'brain');
  mkdirSync(root);
  const sourceId = `facts-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{"federated":true,"facts_visibility":"world"}')`, [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await engine.setConfig('facts.extraction_enabled', 'true');
      await claimWorktree(engine, sourceId, root);
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const put = async (slug: string, content: string) => {
        const prior = await engine.readPageSnapshot(slug, { sourceId });
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(),
          ...(prior ? { expected_revision: prior.revision } : {}) } });
      };
      await seed(put);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await expect(engine.executeRaw(`INSERT INTO facts(source_id,fact,kind,source,visibility) VALUES($1,'uncoordinated','fact','test','private')`,
        [sourceId])).rejects.toThrow(/writer_coordinator_required/);
      await run({ sourceId, root });
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a managed world fact on a private page renders and stores the floored visibility', async () => {
  const slug = 'people/private-person';
  const claim = 'Keeps the board packet in the cabinet.';
  await managed(async put => {
    await put(slug, page('Private Person', 'private'));
  }, async ({ sourceId, root }) => {
    const [floored] = await floorFactRows(engine, sourceId, slug, [{ visibility: 'world' }]);
    expect(floored.visibility).toBe('private');
    const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug, resolutionSource: 'exact_page' }, [
      { fact: claim, kind: 'fact', source: 'fixture', visibility: 'world', notability: 'medium', embedding: null, sessionId: null }]);
    expect(result.inserted).toBe(1);
    const markdown = readFileSync(join(root, 'people/private-person.md'), 'utf8');
    const cell = fenceVisibility(markdown, claim);
    const [row] = await engine.executeRaw<{ visibility: string }>(
      'SELECT visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [sourceId, slug, claim]);
    expect(cell).toBe('private');
    expect(row.visibility).toBe('private');
    expect(cell).toBe(row.visibility);
  });
}, 120_000);

test('a managed world fact on a public page stays world in the fence cell and the stored row', async () => {
  const slug = 'people/public-person';
  const claim = 'Publishes the weekly status note.';
  await managed(async put => {
    await put(slug, page('Public Person', 'world'));
  }, async ({ sourceId, root }) => {
    const [floored] = await floorFactRows(engine, sourceId, slug, [{ visibility: 'world' }]);
    expect(floored.visibility).toBe('world');
    const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug, resolutionSource: 'exact_page' }, [
      { fact: claim, kind: 'fact', source: 'fixture', visibility: 'world', notability: 'medium', embedding: null, sessionId: null }]);
    expect(result.inserted).toBe(1);
    const markdown = readFileSync(join(root, 'people/public-person.md'), 'utf8');
    const cell = fenceVisibility(markdown, claim);
    const [row] = await engine.executeRaw<{ visibility: string }>(
      'SELECT visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [sourceId, slug, claim]);
    expect(cell).toBe('world');
    expect(row.visibility).toBe('world');
    expect(cell).toBe(row.visibility);
  });
}, 120_000);
