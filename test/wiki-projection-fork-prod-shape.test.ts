import { afterAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FORK_VERSION_KEY, runMigrations } from '../src/core/migrate.ts';

const engines: PGLiteEngine[] = [];

afterAll(async () => {
  for (const engine of engines) await engine.disconnect().catch(() => {});
});

test('fork v2 repairs an existing wiki queue on schema 238 and leaves upstream v239 runnable later', async () => {
  const engine = new PGLiteEngine();
  engines.push(engine);
  await engine.connect({});
  await engine.initSchema();

  // Model the production ledger and its already widened page-kind constraint.
  await engine.setConfig('version', '238');
  await engine.setConfig(FORK_VERSION_KEY, '1');
  await engine.executeRaw(`
    INSERT INTO pages (source_id, slug, type, page_kind, title)
    VALUES ('default', 'wiki-review-fixture', 'page', 'wiki', 'Wiki fixture')
  `);
  // Simulate an upgrade target whose existing wiki row predates queueing.
  await engine.executeRaw(`DELETE FROM page_projection_jobs WHERE slug = 'wiki-review-fixture'`);
  const before = await engine.executeRaw<{ count: string }>(`
    SELECT count(*)::text AS count FROM page_projection_jobs
    WHERE slug = 'wiki-review-fixture'
  `);
  expect(before[0]?.count).toBe('0');

  const migrated = await runMigrations(engine);
  expect(migrated).toEqual({ applied: 0, current: 238 });
  expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('2');
  const queued = await engine.executeRaw<{ revision: string; reason: string }>(`
    SELECT j.revision::text AS revision, j.reason
    FROM page_projection_jobs j WHERE j.slug = 'wiki-review-fixture'
  `);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.revision).toBeTruthy();
  expect(queued[0]?.reason).toBe('canonical_change');

  // Re-run the DDL against the same production-shaped state to exercise SQL
  // idempotency, rather than only proving the ledger skip path.
  await engine.setConfig(FORK_VERSION_KEY, '1');
  await runMigrations(engine);
  const queuedAgain = await engine.executeRaw<{ count: string }>(`
    SELECT count(*)::text AS count FROM page_projection_jobs
    WHERE slug = 'wiki-review-fixture'
  `);
  expect(queuedAgain[0]?.count).toBe('1');

  const v239 = {
    version: 239,
    name: 'extract_rollup_halt_reasons',
    idempotent: true,
    sql: `ALTER TABLE extract_rollup_7d ADD COLUMN IF NOT EXISTS halt_reasons JSONB NOT NULL DEFAULT '{}'::jsonb;`,
  };
  const later = await runMigrations(engine, { extraUpstreamMigrations: [v239] });
  expect(later.applied).toBe(1);
  // LATEST_VERSION is intentionally 238 in this lane; the ledger proves the
  // injected upstream v239 ran even though the API reports the compiled latest.
  expect(later.current).toBe(238);
  expect(await engine.getConfig('version')).toBe('239');
  expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('2');
});
