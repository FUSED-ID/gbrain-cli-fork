import type { BrainEngine } from './engine.ts';
import type { Migration } from './schema-migrations/types.ts';

/** Config key for the fork migration high-water mark. */
export const FORK_VERSION_KEY = 'fork_version';

/** Fork-only migrations stay off the upstream schema-version ledger. */
export const FORK_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'oauth_and_access_token_permissions',
    idempotent: true,
    sql: `
      ALTER TABLE oauth_clients
        ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb NOT NULL;
      ALTER TABLE oauth_clients
        ALTER COLUMN permissions SET DEFAULT '{}'::jsonb;
      ALTER TABLE access_tokens
        ADD COLUMN IF NOT EXISTS permissions JSONB
          DEFAULT '{"takes_holders":["world"]}'::jsonb NOT NULL;
      ALTER TABLE access_tokens
        ALTER COLUMN permissions SET DEFAULT '{"takes_holders":["world"]}'::jsonb;
    `,
  },
];

export interface RunMigrationsOptions {
  extraUpstreamMigrations?: readonly Migration[];
}

export async function applyForkMigrations(engine: BrainEngine, applyOne: (engine: BrainEngine, migration: Migration) => Promise<void>): Promise<void> {
  const raw = await engine.getConfig(FORK_VERSION_KEY);
  const current = raw == null || raw.trim() === '' ? 0 : Math.max(0, Number.parseInt(raw, 10) || 0);
  for (const migration of FORK_MIGRATIONS.filter(m => m.version > current).sort((a, b) => a.version - b.version)) {
    await applyOne(engine, migration);
    await engine.setConfig(FORK_VERSION_KEY, String(migration.version));
  }
}
