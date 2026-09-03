import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { repairOauthV127Artifacts } from '../src/core/oauth-v127-selfheal.ts';

describe('fork v127 collision repair at v146', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('moves fork permissions migration after upstream v127', () => {
    expect(MIGRATIONS.find((m) => m.name === 'oauth_and_access_token_permissions')?.version).toBeGreaterThanOrEqual(146);
    expect(MIGRATIONS.find((m) => m.version === 126)?.name).toBe('session_context_state');
    expect(MIGRATIONS.find((m) => m.version === 127)?.name).toBe('oauth_client_surface_and_minion_queue_index');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(146);
  });

  test('a brain stamped by fork v127 receives the upstream v127 artifacts', async () => {
    await engine.executeRaw(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS surface`);
    await engine.executeRaw(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS surface_set_by`);
    await engine.executeRaw(`DROP INDEX IF EXISTS idx_minion_jobs_queue_status_updated`);
    await engine.setConfig('version', '127');

    const before = await engine.executeRaw<{ surface: string; queue_index: string | null }>(
      `SELECT (SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'surface') AS surface,
              to_regclass('idx_minion_jobs_queue_status_updated')::text AS queue_index`,
    );
    expect(before[0]?.surface).toBeNull();
    expect(before[0]?.queue_index).toBeNull();

    await runMigrations(engine);
    const after = await engine.executeRaw<{ surface: string; surface_set_by: string; queue_index: string | null; client_permissions: string; token_permissions: string }>(
      `SELECT
         (SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'surface') AS surface,
         (SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'surface_set_by') AS surface_set_by,
         to_regclass('idx_minion_jobs_queue_status_updated')::text AS queue_index,
         (SELECT data_type FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'permissions') AS client_permissions,
         (SELECT data_type FROM information_schema.columns WHERE table_name = 'access_tokens' AND column_name = 'permissions') AS token_permissions`,
    );
    expect(after[0]).toEqual({
      surface: 'surface',
      surface_set_by: 'surface_set_by',
      queue_index: 'idx_minion_jobs_queue_status_updated',
      client_permissions: 'jsonb',
      token_permissions: 'jsonb',
    });
  });

  test('self-heal is idempotent when artifacts are already present', async () => {
    expect(await repairOauthV127Artifacts(engine)).toEqual({ repaired: false, present: true });
  });
});
