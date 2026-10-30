/**
 * P4 re-projection: a fenced page on a non-federated source keeps one active
 * fact row per fence row when it is projected twice.
 *
 * The P4 insert chokepoint stores the floored visibility (a world fence cell on
 * a non-federated source lands private). The canonical projection's match keys
 * must use that same floored visibility, or the second projection cannot match
 * the stored row and doubles every fact.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const FACT_ROWS = 3;
let engine: PGLiteEngine;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-p4-reproject-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

function pageOf(prose: string): string {
  const facts = ['<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...Array.from({ length: FACT_ROWS }, (_, i) => `| ${i + 1} | Floored claim ${i + 1} | fact | 1.0 | world | medium | 2026-01-01 |  | remember |  |`),
    '<!--- gbrain:facts:end -->'].join('\n');
  return `---\ntype: company\ntitle: Floored company\n---\n${prose}\n\n${facts}\n`;
}

async function withSource(run: (sourceId: string, put: (slug: string, content: string) => Promise<unknown>) => Promise<void>) {
  const dir = mkdtempSync(join(dataDir, 'case-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `p4-reproject-${randomUUID().slice(0, 8)}`;
  // federated is deliberately unset: a non-federated source is the case where the floor makes world rows private.
  const config = { engine: engine.kind, embedding_disabled: true };
  const ctx = { engine, sourceId, remote: false as const, config,
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [sourceId, root, JSON.stringify({})]);
    await claimWorktree(engine, sourceId, root);
    await run(sourceId, (slug, content) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } }));
  });
}

async function projectEdit(sourceId: string, slug: string, content: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const project = await prepareCanonicalProjections(engine, parseMarkdown(content, slug), slug, sourceId, snapshot, 'editing');
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await project(tx);
  }, TEST_WRITE_ATTRIBUTION));
}

async function fenceRows(sourceId: string, slug: string) {
  return engine.executeRaw<{ id: number; row_num: number; visibility: string; expired_at: string | null }>(
    `SELECT id, row_num, visibility, expired_at FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL
      ORDER BY row_num, id`,
    [sourceId, slug],
  );
}

describe('P4 re-projection of floored fence rows', () => {
  test('projecting a non-federated fenced page twice leaves one active private row per fence row', async () => {
    await withSource(async (sourceId, put) => {
      const slug = 'companies/p4-reproject-floored';
      await put(slug, pageOf('First draft.'));

      const first = await fenceRows(sourceId, slug);
      expect(first).toHaveLength(FACT_ROWS);
      for (const row of first) {
        expect(row.visibility).toBe('private');
        expect(row.expired_at).toBeNull();
      }

      await projectEdit(sourceId, slug, pageOf('Second draft with one more sentence.'));

      const second = await fenceRows(sourceId, slug);
      const active = second.filter(row => row.expired_at === null);
      expect(active).toHaveLength(FACT_ROWS);
      expect(active.map(row => row.row_num)).toEqual(first.map(row => row.row_num));
      expect(active.map(row => row.id)).toEqual(first.map(row => row.id));
      for (const row of active) expect(row.visibility).toBe('private');
    });
  }, 120_000);
});
