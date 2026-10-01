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

// The fork never numbers a migration in the upstream sequence. On the harmonized
// build upstream tops out at 178 (v0.60.11.0). The fork's own migration (oauth
// permissions) lives on the fork_version ledger as number 1.
const UPSTREAM_MAX = 178;
// The upstream number the old fork migration used to occupy. Production was
// stamped with it, so the stamp repair sets it back to 165 before the first start.
const OLD_FORK_STAMP = 166;
const UPSTREAM_BEFORE_COLLISION = 165;

function upstreamAbove(stamp: number): number[] {
  return MIGRATIONS.map((m) => m.version).filter((v) => v > stamp).sort((a, b) => a - b);
}

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
  test('fork ledger (a) upstream list is untouched by the fork, fresh database stamps 178 and records oauth', async () => {
    expect(LATEST_VERSION).toBe(UPSTREAM_MAX);
    expect(Math.max(...MIGRATIONS.map((m) => m.version))).toBe(UPSTREAM_MAX);
    expect(MIGRATIONS.find((m) => m.version === OLD_FORK_STAMP)?.name).toBe('fact_embedding_identity');
    expect(MIGRATIONS.find((m) => m.name === 'oauth_and_access_token_permissions')).toBeUndefined();
    const fork = FORK_MIGRATIONS.find((m) => m.name === 'oauth_and_access_token_permissions');
    expect(fork?.version).toBe(1);
    expect(fork?.idempotent).toBe(true);
    expect(fork?.sql ?? '').toContain('ADD COLUMN IF NOT EXISTS');
    // Upstream 166 through 178 are all present and contiguous.
    expect(upstreamAbove(UPSTREAM_BEFORE_COLLISION)).toEqual(
      Array.from({ length: UPSTREAM_MAX - UPSTREAM_BEFORE_COLLISION }, (_, i) => UPSTREAM_BEFORE_COLLISION + 1 + i),
    );

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

  test('fork ledger (b) unrepaired production stamp 166 skips upstream 166, runs 167 to 178 and records the ledger', async () => {
    // This is the hazard the stamp repair removes: the old fork migration stamped 166,
    // so the upstream runner (m.version > current) never runs upstream 166. The runbook
    // sets the stamp back to 165 before the first start of this build.
    await withStartedEngine(async (engine) => {
      const before = await oauthShape(engine);
      expect(before.client_permissions).toBe('jsonb');
      expect(before.token_permissions).toBe('jsonb');

      await engine.unsetConfig(FORK_VERSION_KEY);
      await engine.setConfig('version', String(OLD_FORK_STAMP));
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBeNull();
      expect(await hasPendingMigrations(engine)).toBe(true);

      const { writes } = spyConfig(engine);
      const result = await runMigrations(engine);
      const versionWrites = writes.filter((entry) => entry.startsWith('version='));
      const forkWrites = writes.filter((entry) => entry.startsWith(`${FORK_VERSION_KEY}=`));
      const expected = upstreamAbove(OLD_FORK_STAMP);

      expect(expected[0]).toBe(167);
      expect(result).toEqual({ applied: expected.length, current: UPSTREAM_MAX });
      expect(versionWrites).toEqual(expected.map((v) => `version=${v}`));
      expect(versionWrites).not.toContain(`version=${OLD_FORK_STAMP}`);
      expect(forkWrites).toEqual([`${FORK_VERSION_KEY}=1`]);
      expect(await engine.getConfig('version')).toBe(String(UPSTREAM_MAX));
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(await hasPendingMigrations(engine)).toBe(false);
    });
  }, 180_000);

  test('fork ledger (c) repaired stamp 165 with ledger 1 runs upstream 166 to 178 in order and leaves the ledger alone', async () => {
    await withStartedEngine(async (engine) => {
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      await engine.setConfig('version', String(UPSTREAM_BEFORE_COLLISION));
      expect(await hasPendingMigrations(engine)).toBe(true);

      const { writes } = spyConfig(engine);
      const result = await runMigrations(engine);
      const versionWrites = writes.filter((entry) => entry.startsWith('version='));
      const expected = upstreamAbove(UPSTREAM_BEFORE_COLLISION);

      expect(expected.length).toBe(13);
      expect(result).toEqual({ applied: 13, current: UPSTREAM_MAX });
      // Strictly ascending, one write per migration, 166 first and 178 last.
      expect(versionWrites).toEqual(expected.map((v) => `version=${v}`));
      expect(versionWrites[0]).toBe('version=166');
      expect(versionWrites[versionWrites.length - 1]).toBe(`version=${UPSTREAM_MAX}`);
      // The ledger is already at 1, so the runner has nothing to stamp there.
      expect(writes.filter((entry) => entry.startsWith(`${FORK_VERSION_KEY}=`))).toEqual([]);
      expect(await engine.getConfig('version')).toBe(String(UPSTREAM_MAX));
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      const shape = await oauthShape(engine);
      expect(shape.client_permissions).toBe('jsonb');
      expect(shape.token_permissions).toBe('jsonb');
      expect(await hasPendingMigrations(engine)).toBe(false);
    });
  }, 180_000);

  test('fork ledger (d) second startup is a no-op and never writes version', async () => {
    await withStartedEngine(async (engine) => {
      await runMigrations(engine);
      expect(await engine.getConfig('version')).toBe(String(UPSTREAM_MAX));
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(await hasPendingMigrations(engine)).toBe(false);

      const { writes } = spyConfig(engine);
      const first = await runMigrations(engine);
      const second = await runMigrations(engine);
      expect(first).toEqual({ applied: 0, current: UPSTREAM_MAX });
      expect(second).toEqual({ applied: 0, current: UPSTREAM_MAX });
      expect(writes).toEqual([]);
      expect(await engine.getConfig('version')).toBe(String(UPSTREAM_MAX));
      expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
      expect(await hasPendingMigrations(engine)).toBe(false);
    });
  }, 120_000);

  test('fork ledger (e) a missing ledger is pending on its own and moves only fork_version', async () => {
    await withStartedEngine(async (engine) => {
      await engine.unsetConfig(FORK_VERSION_KEY);
      expect(await engine.getConfig('version')).toBe(String(UPSTREAM_MAX));
      expect(await hasPendingMigrations(engine)).toBe(true);

      const { writes } = spyConfig(engine);
      const result = await runMigrations(engine);
      expect(result).toEqual({ applied: 0, current: UPSTREAM_MAX });
      expect(writes).toEqual([`${FORK_VERSION_KEY}=1`]);
      expect(await hasPendingMigrations(engine)).toBe(false);
    });
  }, 120_000);
});
