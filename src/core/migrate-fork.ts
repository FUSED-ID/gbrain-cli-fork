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
  {
    version: 2,
    name: 'wiki_page_projection_queue',
    idempotent: true,
    sql: `
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_page_kind_check;
      ALTER TABLE pages ADD CONSTRAINT pages_page_kind_check
        CHECK (page_kind IN ('markdown','wiki','code','image'));

      INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change'
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.deleted_at IS NULL AND NOT s.archived AND p.page_kind='wiki'
        AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
      ON CONFLICT(source_incarnation,slug) DO UPDATE
        SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now();
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
