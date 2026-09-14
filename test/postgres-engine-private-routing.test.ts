/**
 * D1 policy fix, PostgresEngine coverage.
 *
 * Every existing guard test for the D1 private-write guard exercises only
 * PGLiteEngine. The live gbrain-sync path runs on PostgresEngine
 * (postgres-engine.ts putPage, around the ON CONFLICT block this lane
 * touched), so a regression there would ship with zero coverage. This file
 * exercises the SAME scenarios directly against a real Postgres connection.
 *
 * Requires a local Postgres reachable at DATABASE_URL, pointed at a
 * disposable, clearly test-shaped database (assertSafeE2eDatabaseUrl
 * enforces the name). Skips itself (does not fail) when DATABASE_URL is
 * unset, matching the rest of the e2e-shaped suite's opt-in convention.
 * NEVER point this at a real brain's database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let engine: PostgresEngine;
let policyDir: string;

function writePolicy(excluded: string): void {
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(join(policyDir, '_excluded-people.md'), excluded);
}

async function pointPrivateSource(localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [localPath],
  );
}

describeIfDb('PostgresEngine: D1 private-write policy guard', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) return;
    assertSafeE2eDatabaseUrl(DATABASE_URL);
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL, poolSize: 3 });
    await engine.initSchema();
    await engine.executeRaw(
      `UPDATE sources
       SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb) || '{"facts_visibility":"world"}'::jsonb
       WHERE id = 'default'`,
    );
  }, 120_000);

  afterAll(async () => {
    if (!engine) return;
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'pg-d1-%' OR slug LIKE 'wiki/pg-d1-%'`);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
    await engine.disconnect();
    if (policyDir && existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (!DATABASE_URL) return;
    policyDir = mkdtempSync(join(tmpdir(), 'gbrain-pg-d1-'));
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'pg-d1-%' OR slug LIKE 'wiki/pg-d1-%'`);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
  });

  test('deny-list match is refused on PostgresEngine', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `pg-d1-denylisted*` | PG D1 Denylisted |\n');
    const page = {
      type: 'concept', title: 'PG D1 Denylisted', compiled_truth: 'body', timeline: '', frontmatter: {},
    } as const;

    await expect(engine.putPage('people/pg-d1-denylisted', page, { sourceId: 'default' }))
      .rejects.toThrow(/excluded_people_policy/);
  });

  test('a slug not on the deny list and not live in lg-private is ALLOWED on PostgresEngine', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    const slug = 'wiki/pg-d1-new-contact/_author';
    const page = {
      type: 'note', title: 'PG D1 New Contact', compiled_truth: 'ordinary contact body', timeline: '', frontmatter: {},
    } as const;

    const written = await engine.putPage(slug, page, { sourceId: 'default' });
    expect(written.slug).toBe(slug);
    const roundTrip = await engine.getPage(slug, { sourceId: 'default' });
    expect(roundTrip?.compiled_truth).toBe(page.compiled_truth);
  });

  test('a slug live in lg-private is refused on PostgresEngine', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('pg-d1-private-person', {
      type: 'concept', title: 'PG D1 Private Person', compiled_truth: 'private copy', timeline: '', frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('people/pg-d1-private-person', {
      type: 'concept', title: 'PG D1 Private Person', compiled_truth: 'leaked shape', timeline: '', frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/existing_private_page/);
  });

  test('a target row deleted concurrently with the write is NOT resurrected on PostgresEngine', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    const slug = 'pg-d1-concurrently-purged';
    const page = {
      type: 'concept', title: 'PG D1 Concurrently Purged', compiled_truth: 'original body', timeline: '', frontmatter: {},
    } as const;

    await engine.putPage(slug, page, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() + interval '1 hour' WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );

    await expect(engine.putPage(slug, {
      ...page,
      compiled_truth: 'attempted resurrection',
    }, { sourceId: 'default' })).rejects.toThrow(/deleted concurrently/);

    const raw = await engine.executeRaw<{ deleted_at: string | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(raw[0]?.deleted_at).not.toBeNull();
    expect(raw[0]?.compiled_truth).toBe('original body');
  });

  test('migrationWrite exempts a personish write from the guard on PostgresEngine', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `pg-d1-migrate-exempt*` | PG D1 Migrate Exempt |\n');
    // This slug matches the deny list; without migrationWrite it would be
    // refused, matching the deny-list test above.
    const written = await engine.putPage('people/pg-d1-migrate-exempt', {
      type: 'concept', title: 'PG D1 Migrate Exempt', compiled_truth: 'migrated body', timeline: '', frontmatter: {},
    }, { sourceId: 'default', migrationWrite: true });
    expect(written.slug).toBe('people/pg-d1-migrate-exempt');
  });
});
