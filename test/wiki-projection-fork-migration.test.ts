import { afterAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FORK_MIGRATIONS, FORK_VERSION_KEY, LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

const opened: PGLiteEngine[] = [];

function openEngine(): PGLiteEngine {
  const engine = new PGLiteEngine();
  opened.push(engine);
  return engine;
}

afterAll(async () => {
  for (const engine of opened) await engine.disconnect().catch(() => {});
});

describe('wiki projection fork migration', () => {
  test('keeps upstream at 238, records fork 2, is repeatable, and leaves upstream 239 available', async () => {
    expect(LATEST_SCHEMA_VERSION).toBe(238);
    expect(LATEST_VERSION).toBe(238);
    expect(Math.max(...MIGRATIONS.map((migration) => migration.version))).toBe(238);
    expect(MIGRATIONS.find((migration) => migration.name === 'wiki_page_projections')).toBeUndefined();

    const wiki = FORK_MIGRATIONS.find((migration) => migration.name === 'wiki_page_projection_queue');
    expect(wiki?.version).toBe(2);
    expect(wiki?.idempotent).toBe(true);
    expect(wiki?.sql).toContain("page_kind IN ('markdown','wiki','code','image')");
    expect(FORK_MIGRATIONS.filter((migration) => migration.version === 2)).toHaveLength(1);

    const engine = openEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const first = await runMigrations(engine, {
        extraUpstreamMigrations: [{ version: 239, name: 'extract_rollup_halt_reasons', idempotent: true, sql: "CREATE TABLE IF NOT EXISTS fork_test_upstream_239 (id INTEGER PRIMARY KEY);" }],
      });
      expect(await engine.getConfig('version')).toBe('239');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('2');
      expect(first).toEqual({ applied: 1, current: 238 });
      const second = await runMigrations(engine);
      expect(second).toEqual({ applied: 0, current: 239 });
      expect(await engine.getConfig('version')).toBe('239');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('2');
      const futureTable = await engine.executeRaw<{ table_name: string | null }>("SELECT to_regclass('fork_test_upstream_239')::text AS table_name");
      expect(futureTable[0]?.table_name).toBe('fork_test_upstream_239');
    } finally {
      await engine.disconnect();
    }
  }, 180_000);
});
