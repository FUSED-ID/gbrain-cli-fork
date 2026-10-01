import { describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  FORK_MIGRATIONS,
  FORK_VERSION_KEY,
  LATEST_VERSION,
  MIGRATIONS,
  hasPendingMigrations,
  runMigrations,
} from '../src/core/migrate.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';

const UPSTREAM_MAX = 165;

interface OauthShape {
  oauth_clients: string | null;
  access_tokens: string | null;
  client_permissions: string | null;
  token_permissions: string | null;
}

async function oauthShape(engine: PGLiteEngine): Promise<OauthShape> {
  const [row] = await engine.executeRaw<OauthShape>(
    `SELECT
       to_regclass('oauth_clients')::text AS oauth_clients,
       to_regclass('access_tokens')::text AS access_tokens,
       (SELECT data_type FROM information_schema.columns
         WHERE table_name = 'oauth_clients' AND column_name = 'permissions') AS client_permissions,
       (SELECT data_type FROM information_schema.columns
         WHERE table_name = 'access_tokens' AND column_name = 'permissions') AS token_permissions`,
  );
  if (!row) throw new Error('oauth shape query returned no row');
  return row;
}

async function withStartedEngine(fn: (engine: PGLiteEngine) => Promise<void>): Promise<void> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

function spyConfig(engine: PGLiteEngine): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  const origGet = engine.getConfig.bind(engine);
  const origSet = engine.setConfig.bind(engine);
  const target = engine as unknown as {
    getConfig: (key: string) => Promise<string | null>;
    setConfig: (key: string, value: string) => Promise<void>;
  };
  target.getConfig = async (key: string) => {
    reads.push(key);
    return origGet(key);
  };
  target.setConfig = async (key: string, value: string) => {
    writes.push(`${key}=${value}`);
    await origSet(key, value);
  };
  return { reads, writes };
}

describe('fork ledger', () => {
  test('fork ledger (a) fresh database stamps upstream 165 and records oauth', async () => {
    expect(LATEST_VERSION).toBe(UPSTREAM_MAX);
    expect(Math.max(...MIGRATIONS.map((m) => m.version))).toBe(UPSTREAM_MAX);
    expect(MIGRATIONS.some((m) => m.version > UPSTREAM_MAX)).toBe(false);
    expect(MIGRATIONS.find((m) => m.name === 'oauth_and_access_token_permissions')).toBeUndefined();
    const fork = FORK_MIGRATIONS.find((m) => m.name === 'oauth_and_access_token_permissions');
    expect(fork?.version).toBe(1);
    expect(fork?.idempotent).toBe(true);
    expect(fork?.sql ?? '').toContain('ADD COLUMN IF NOT EXISTS');

    await withColdPglite(async () => {
      const engine = new PGLiteEngine();
      await engine.connect({});
      try {
        await engine.initSchema();
        expect(await engine.getConfig('version')).toBe(String(UPSTREAM_MAX));
        expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
        const shape = await oauthShape(engine);
        expect(shape.oauth_clients ?? '').toContain('oauth_clients');
        expect(shape.access_tokens ?? '').toContain('access_tokens');
        expect(shape.client_permissions).toBe('jsonb');
        expect(shape.token_permissions).toBe('jsonb');
        expect(await hasPendingMigrations(engine)).toBe(false);
      } finally {
        await engine.disconnect();
      }
    });
  }, 180_000);

  test('fork ledger (b) production stamp 166 records fork ledger without moving version', async () => {
    await withStartedEngine(async (engine) => {
      const before = await oauthShape(engine);
      expect(before.oauth_clients ?? '').toContain('oauth_clients');
      expect(before.access_tokens ?? '').toContain('access_tokens');
      expect(before.client_permissions).toBe('jsonb');
      expect(before.token_permissions).toBe('jsonb');

      await engine.unsetConfig(FORK_VERSION_KEY);
      await engine.setConfig('version', '166');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBeNull();
      expect(await engine.getConfig('version')).toBe('166');
      expect(await hasPendingMigrations(engine)).toBe(true);

      const { reads, writes } = spyConfig(engine);
      const result = await runMigrations(engine);
      // Later expects call getConfig through the same spy. Snapshot the
      // runner's own traffic before those calls.
      const versionReads = reads.filter((key) => key === 'version');
      const forkReads = reads.filter((key) => key === FORK_VERSION_KEY);
      const versionWrites = writes.filter((entry) => entry.startsWith('version='));
      const forkWrites = writes.filter((entry) => entry.startsWith(`${FORK_VERSION_KEY}=`));

      expect(result).toEqual({ applied: 0, current: 166 });
      expect(await engine.getConfig('version')).toBe('166');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(versionWrites).toEqual([]);
      expect(forkWrites).toEqual([`${FORK_VERSION_KEY}=1`]);
      expect(versionReads).toEqual(['version']);
      expect(forkReads.length).toBeGreaterThan(0);
      expect(await hasPendingMigrations(engine)).toBe(false);

      const after = await oauthShape(engine);
      expect(after.client_permissions).toBe('jsonb');
      expect(after.token_permissions).toBe('jsonb');
    });
  }, 120_000);

  test('fork ledger (c) repaired stamp 165 applies simulated upstream 166 and keeps fork ledger at 1', async () => {
    await withStartedEngine(async (engine) => {
      await engine.unsetConfig(FORK_VERSION_KEY);
      await engine.setConfig('version', '166');
      const recorded = await runMigrations(engine);
      expect(recorded).toEqual({ applied: 0, current: 166 });
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(await engine.getConfig('version')).toBe('166');

      await engine.setConfig('version', '165');
      expect(await engine.getConfig('version')).toBe('165');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');

      const result = await runMigrations(engine, {
        extraUpstreamMigrations: [{
          version: 166,
          name: 'simulated_upstream_v166',
          idempotent: true,
          sql: 'CREATE TABLE IF NOT EXISTS simulated_upstream_v166 (id INTEGER);',
        }],
      });

      expect(result.applied).toBe(1);
      expect(await engine.getConfig('version')).toBe('166');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      const [row] = await engine.executeRaw<{ reg: string | null }>(
        `SELECT to_regclass('simulated_upstream_v166')::text AS reg`,
      );
      expect(row?.reg ?? '').toContain('simulated_upstream_v166');
      const shape = await oauthShape(engine);
      expect(shape.oauth_clients ?? '').toContain('oauth_clients');
      expect(shape.access_tokens ?? '').toContain('access_tokens');
      expect(shape.client_permissions).toBe('jsonb');
      expect(shape.token_permissions).toBe('jsonb');
    });
  }, 120_000);

  test('fork ledger (d) second startup is a no-op', async () => {
    await withStartedEngine(async (engine) => {
      await runMigrations(engine);
      const version = await engine.getConfig('version');
      const fork = await engine.getConfig(FORK_VERSION_KEY);
      expect(fork).toBe('1');
      expect(version === '165' || version === '166').toBe(true);
      expect(await hasPendingMigrations(engine)).toBe(false);

      const { writes } = spyConfig(engine);
      const first = await runMigrations(engine);
      const second = await runMigrations(engine);
      expect(first).toEqual({ applied: 0, current: Number(version) });
      expect(second).toEqual({ applied: 0, current: Number(version) });
      expect(writes).toEqual([]);
      expect(await engine.getConfig('version')).toBe(version);
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(await hasPendingMigrations(engine)).toBe(false);

      await engine.setConfig('version', '166');
      const again = await runMigrations(engine);
      const third = await runMigrations(engine);
      expect(again).toEqual({ applied: 0, current: 166 });
      expect(third).toEqual({ applied: 0, current: 166 });
      expect(writes.filter((entry) => entry.startsWith('version='))).toEqual(['version=166']);
      expect(await engine.getConfig('version')).toBe('166');
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(await hasPendingMigrations(engine)).toBe(false);
    });
  }, 120_000);
});
