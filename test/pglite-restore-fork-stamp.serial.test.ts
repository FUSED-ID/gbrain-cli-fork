import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { FORK_VERSION_KEY } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * A PGLite backup stamped 166 is the old fork oauth migration, which this
 * binary reads as upstream schema 165 plus fork ledger 1. 167 is newer than
 * anything this binary can restore.
 */
let temporary = '';
let root = '';
let archive166 = '';
let archive167 = '';

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
    await engine.setConfig('version', '166');
    await engine.unsetConfig(FORK_VERSION_KEY);
  });
  archive166 = join(temporary, 'stamp-166.gbrain-backup');
  await createPgliteBackup({ root, output: archive166 });
  await withEngine(databasePath, async (engine) => {
    await engine.setConfig('version', '167');
  });
  archive167 = join(temporary, 'stamp-167.gbrain-backup');
  await createPgliteBackup({ root, output: archive167 });
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

test('schema 167 is still refused', async () => {
  const into = join(temporary, 'restored-167');
  await expect(restorePgliteBackup({ archive: archive167, into })).rejects.toMatchObject({
    code: 'newer_backup_schema',
  });
}, 120_000);

test('schema 166 without fork oauth columns is refused', async () => {
  const databasePath = join(root, '.gbrain', 'brain.pglite');
  await withEngine(databasePath, async (engine) => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN IF EXISTS permissions');
    await engine.executeRaw('ALTER TABLE access_tokens DROP COLUMN IF EXISTS permissions');
    await engine.setConfig('version', '166');
  });
  const archive = join(temporary, 'stamp-166-plain.gbrain-backup');
  await createPgliteBackup({ root, output: archive });
  const into = join(temporary, 'restored-166-plain');
  await expect(restorePgliteBackup({ archive, into })).rejects.toMatchObject({
    code: 'newer_backup_schema',
  });
}, 120_000);
