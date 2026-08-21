import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS } from '../src/core/migrate.ts';

describe('migration v126/v127 schema coverage', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    // No database_path means this is an isolated in-memory PGLite database.
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine?.disconnect();
  }, 60_000);

  test('keeps upstream v126 and fork-local v127 in distinct registry slots', () => {
    expect(MIGRATIONS.find(m => m.version === 126)?.name).toBe('session_context_state');
    expect(MIGRATIONS.find(m => m.version === 127)?.name).toBe('oauth_and_access_token_permissions');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(127);
  });

  test('fresh migrations create session state and both permissions columns', async () => {
    const tables = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'session_context_state'`,
      [],
    );
    expect(tables.map(row => row.table_name)).toContain('session_context_state');

    const columns = await engine.executeRaw<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'permissions'
          AND table_name IN ('oauth_clients', 'access_tokens')
        ORDER BY table_name`,
      [],
    );
    expect(columns).toEqual([
      { table_name: 'access_tokens', data_type: 'jsonb' },
      { table_name: 'oauth_clients', data_type: 'jsonb' },
    ]);
  });
});

// #D10-live drift case: a brain stamped past v126 without the table gets the
// table back on the next runMigrations pass, even when nothing is pending.
import { runMigrations } from '../src/core/migrate.ts';

describe('session_context_state self-heal (#D10-live)', () => {
  test('recreates the table on a stamped-ahead brain with no pending migrations', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Simulate the live M4 drift: version counter ahead, table missing.
    await engine.executeRaw(`DROP TABLE IF EXISTS session_context_state`, []);
    const before = await engine.executeRaw<{ reg: string | null }>(
      `SELECT to_regclass('session_context_state')::text AS reg`, []);
    expect(before[0]?.reg).toBeNull();
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0); // nothing pending — self-heal path only
    const after = await engine.executeRaw<{ reg: string | null }>(
      `SELECT to_regclass('session_context_state')::text AS reg`, []);
    expect(after[0]?.reg).toBe('session_context_state');
    await engine.disconnect();
  }, 120_000);
});
