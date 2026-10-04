import { describe, expect, test } from 'bun:test';
import { SCHEMA_SQL } from '../src/core/schema-embedded.generated.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { FORK_MIGRATIONS } from '../src/core/migrate.ts';

const WORLD_ONLY_DEFAULT = `permissions  JSONB DEFAULT '{"takes_holders":["world"]}'::jsonb NOT NULL`;

describe('legacy access-token visibility defaults', () => {
  test('fresh Postgres, PGLite, and fork-ledger schemas default legacy tokens to world-only', () => {
    expect(SCHEMA_SQL).toContain(WORLD_ONLY_DEFAULT);
    expect(PGLITE_SCHEMA_SQL).toContain(WORLD_ONLY_DEFAULT);

    const forkMigration = FORK_MIGRATIONS.find((m) => m.name === 'oauth_and_access_token_permissions');
    expect(forkMigration?.sql ?? '').toContain(`DEFAULT '{"takes_holders":["world"]}'::jsonb NOT NULL`);
  });
});
