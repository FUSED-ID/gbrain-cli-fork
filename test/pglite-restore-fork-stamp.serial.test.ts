import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { FORK_VERSION_KEY, LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * A PGLite backup stamped 166 is the old fork oauth migration when the dump
 * has the fork oauth columns and no facts.embedding_model column. Restore
 * reads that as upstream schema 165 plus fork ledger 1, including when the
 * caller simulates LATEST_VERSION 166. A stamp 166 dump that already has
 * facts.embedding_model is upstream 166 and stays 166. A stamp above the real
 * schema ceiling (LATEST_VERSION, 178 on v0.60.11.0) is refused. Since upstream
 * v166 is now a real migration, the old-fork fixture removes
 * facts.embedding_model from a freshly initialised brain, which is how a dump
 * taken before upstream 166 looks.
 */
let temporary = '';
let root = '';
let archive166 = '';
let archiveAbove = '';

async function withEngine<T>(
  databasePath: string,
  fn: (engine: PGLiteEngine) => Promise<T>,
  forRestore = false,
): Promise<T> {
  const engine = new PGLiteEngine();
  const config = { engine: 'pglite' as const, database_path: databasePath };
  if (forRestore) await engine.connectForRestore(config);
  else await engine.connect(config);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

async function oauthPermissions(engine: PGLiteEngine): Promise<{
  client_permissions: string | null;
  token_permissions: string | null;
}> {
  const [row] = await engine.executeRaw<{
    client_permissions: string | null;
    token_permissions: string | null;
  }>(
    `SELECT
       (SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'oauth_clients' AND column_name = 'permissions') AS client_permissions,
       (SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'access_tokens' AND column_name = 'permissions') AS token_permissions`,
  );
  if (!row) throw new Error('oauth permissions query returned no row');
  return row;
}

beforeAll(async () => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-fork-stamp-restore-')));
  root = join(temporary, 'brain');
  mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
  const databasePath = join(root, '.gbrain', 'brain.pglite');
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: databasePath,
    embedding_disabled: true,
  }));
  await withEngine(databasePath, async (engine) => {
    await engine.initSchema();
    const shape = await oauthPermissions(engine);
    if (shape.client_permissions !== 'jsonb' || shape.token_permissions !== 'jsonb') {
      throw new Error('fixture is missing fork oauth columns');
    }
    await engine.executeRaw('ALTER TABLE facts DROP COLUMN IF EXISTS embedding_model');
    await engine.setConfig('version', '166');
    await engine.unsetConfig(FORK_VERSION_KEY);
  });
  archive166 = join(temporary, 'stamp-166.gbrain-backup');
  await createPgliteBackup({ root, output: archive166 });
  await withEngine(databasePath, async (engine) => {
    await engine.setConfig('version', String(LATEST_VERSION + 1));
  });
  archiveAbove = join(temporary, 'stamp-above-latest.gbrain-backup');
  await createPgliteBackup({ root, output: archiveAbove });
}, 240_000);

afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test('schema 166 with fork oauth columns restores as upstream 165 plus fork ledger 1', async () => {
  const into = join(temporary, 'restored-166');
  const result = await restorePgliteBackup({ archive: archive166, into });
  expect(result.root).toBe(into);
  await withEngine(join(into, '.gbrain', 'brain.pglite'), async (engine) => {
    expect(await engine.getConfig('version')).toBe('165');
    expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
    const shape = await oauthPermissions(engine);
    expect(shape.client_permissions).toBe('jsonb');
    expect(shape.token_permissions).toBe('jsonb');
  }, true);
}, 120_000);

test('a schema above this binary is still refused', async () => {
  const into = join(temporary, 'restored-above-latest');
  await expect(restorePgliteBackup({ archive: archiveAbove, into })).rejects.toMatchObject({
    code: 'newer_backup_schema',
  });
}, 120_000);

test('schema 166 without fork oauth columns is refused under simulated latest 165', async () => {
  const databasePath = join(root, '.gbrain', 'brain.pglite');
  await withEngine(databasePath, async (engine) => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN IF EXISTS permissions');
    await engine.executeRaw('ALTER TABLE access_tokens DROP COLUMN IF EXISTS permissions');
    await engine.setConfig('version', '166');
  });
  const archive = join(temporary, 'stamp-166-plain.gbrain-backup');
  await createPgliteBackup({ root, output: archive });
  const into = join(temporary, 'restored-166-plain');
  await expect(restorePgliteBackup({ archive, into, latestVersion: 165 })).rejects.toMatchObject({
    code: 'newer_backup_schema',
  });
}, 120_000);

test('fork stamp 166 under simulated latest 166 restores as upstream 165 plus fork ledger 1', async () => {
  const into = join(temporary, 'restored-166-simulated-latest');
  const result = await restorePgliteBackup({ archive: archive166, into, latestVersion: 166 });
  expect(result.root).toBe(into);
  await withEngine(join(into, '.gbrain', 'brain.pglite'), async (engine) => {
    expect(await engine.getConfig('version')).toBe('165');
    expect(await engine.getConfig(FORK_VERSION_KEY)).toBe('1');
    const shape = await oauthPermissions(engine);
    expect(shape.client_permissions).toBe('jsonb');
    expect(shape.token_permissions).toBe('jsonb');
  }, true);
}, 120_000);

test('upstream schema 166 with facts.embedding_model restores unchanged under simulated latest 166', async () => {
  const databasePath = join(root, '.gbrain', 'brain.pglite');
  await withEngine(databasePath, async (engine) => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN IF EXISTS permissions');
    await engine.executeRaw('ALTER TABLE access_tokens DROP COLUMN IF EXISTS permissions');
    await engine.executeRaw('ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedding_model TEXT');
    await engine.setConfig('version', '166');
    await engine.unsetConfig(FORK_VERSION_KEY);
  });
  const archive = join(temporary, 'stamp-166-upstream.gbrain-backup');
  await createPgliteBackup({ root, output: archive });
  const into = join(temporary, 'restored-166-upstream');
  const result = await restorePgliteBackup({ archive, into, latestVersion: 166 });
  expect(result.root).toBe(into);
  await withEngine(join(into, '.gbrain', 'brain.pglite'), async (engine) => {
    expect(await engine.getConfig('version')).toBe('166');
    expect(await engine.getConfig(FORK_VERSION_KEY)).toBeNull();
    const shape = await oauthPermissions(engine);
    expect(shape.client_permissions).toBeNull();
    expect(shape.token_permissions).toBeNull();
    const [column] = await engine.executeRaw<{ embedding_model: string | null }>(
      `SELECT data_type AS embedding_model FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'facts' AND column_name = 'embedding_model'`,
    );
    expect(column?.embedding_model).toBe('text');
  }, true);
}, 120_000);
