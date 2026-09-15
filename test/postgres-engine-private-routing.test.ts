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

  test('collision allowlist exempts rule (b) only, never rule (a) (T-LEAK-7)', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `pg-d1-denylisted*` | PG D1 Denylisted |\n');
    const allowlistPath = join(policyDir, 'privacy-allowlist.tsv');
    const priorAllowlistPath = process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH;
    process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = allowlistPath;
    try {
      // Mirrors the live shape: the private profile lives at the BARE slug
      // in lg-private (see person/chris-hooper's real private page,
      // 'chris-hooper', no /_author suffix); the public stub is written to
      // `default` at the /_author-suffixed slug. Rule (b) matches these via
      // candidateKeys' stripAuthorSuffix walk, not an exact-string match.
      const stubSlug = 'pg-d1-chris-hooper/_author';
      const privateSlug = 'pg-d1-chris-hooper';
      await engine.putPage(privateSlug, {
        type: 'concept', title: 'PG D1 Chris Hooper', compiled_truth: 'private stub', timeline: '', frontmatter: {},
      }, { sourceId: 'lg-private' });

      // No allowlist file at all yet: rule (b) refuses, matching the plain
      // existing-private-page test above.
      await expect(engine.putPage(stubSlug, {
        type: 'concept', title: 'PG D1 Chris Hooper', compiled_truth: 'public stub attempt 1', timeline: '', frontmatter: {},
      }, { sourceId: 'default' })).rejects.toThrow(/existing_private_page/);

      // Add the exact-slug collision row: rule (b) is exempted, the write
      // to `default` succeeds even though the identity is live in lg-private.
      writeFileSync(allowlistPath, '# T-LEAK-7 collision exemptions\ncollision|' + stubSlug + '\n');
      const written = await engine.putPage(stubSlug, {
        type: 'concept', title: 'PG D1 Chris Hooper', compiled_truth: 'public stub attempt 2', timeline: '', frontmatter: {},
      }, { sourceId: 'default' });
      expect(written.slug).toBe(stubSlug);

      // Remove the row: rule (b) refuses again.
      writeFileSync(allowlistPath, '# T-LEAK-7 collision exemptions\n');
      await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [stubSlug]);
      await expect(engine.putPage(stubSlug, {
        type: 'concept', title: 'PG D1 Chris Hooper', compiled_truth: 'public stub attempt 3', timeline: '', frontmatter: {},
      }, { sourceId: 'default' })).rejects.toThrow(/existing_private_page/);

      // Rule (a), the deny-list match, is NEVER exempted by a collision row,
      // even one naming the exact denied slug.
      const deniedSlug = 'people/pg-d1-denylisted';
      writeFileSync(allowlistPath, 'collision|' + deniedSlug + '\n');
      await expect(engine.putPage(deniedSlug, {
        type: 'concept', title: 'PG D1 Denylisted', compiled_truth: 'body', timeline: '', frontmatter: {},
      }, { sourceId: 'default' })).rejects.toThrow(/excluded_people_policy/);

      // Defect 1 fix, second binding NO-GO: the case above passes even with
      // the bug present, because it seeds no private page for the denied
      // slug, so rule (b) never fires and never has a chance to shadow rule
      // (a). Repeat it WITH a live private page for the same identity, so a
      // regression to "rule (b) evaluated before rule (a)" would flip this
      // back to reason: 'existing_private_page' and the collisionExempt
      // check below would wrongly admit it.
      const deniedBareSlug = 'pg-d1-denylisted-with-private-page';
      const deniedSlugWithPrivatePage = 'people/pg-d1-denylisted-with-private-page';
      await engine.putPage(deniedBareSlug, {
        type: 'concept', title: 'PG D1 Denylisted With Private Page', compiled_truth: 'private copy', timeline: '', frontmatter: {},
      }, { sourceId: 'lg-private' });
      writeFileSync(allowlistPath, 'collision|' + deniedSlugWithPrivatePage + '\n');
      await expect(engine.putPage(deniedSlugWithPrivatePage, {
        type: 'concept', title: 'PG D1 Denylisted With Private Page', compiled_truth: 'leaked shape', timeline: '', frontmatter: {},
      }, { sourceId: 'default' })).rejects.toThrow(/excluded_people_policy/);
      const stillNotInDefault = await engine.getPage(deniedSlugWithPrivatePage, { sourceId: 'default' });
      expect(stillNotInDefault).toBeNull();
    } finally {
      if (priorAllowlistPath === undefined) delete process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH;
      else process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = priorAllowlistPath;
    }
  });

  test('KNOWN GAP: a HARD delete in the write gap is not covered, the page is recreated', async () => {
    // Documents a gap the tombstone-race guard does NOT close (see the
    // Tombstone race guard comment in postgres-engine.ts putPage): a hard
    // DELETE landing between this write's checks and its INSERT ... ON
    // CONFLICT leaves no conflicting row for the guard's WHERE clause to
    // evaluate at all, so the purge is silently undone as an ordinary
    // INSERT. This is a synthetic reproduction of that shape; it is not a
    // claim that this happened to any specific real page (defect 4
    // correction, binding NO-GO 20260915: the live database has no
    // 'default' row, live or tombstoned, for person/chris-hooper -- only an
    // lg-private one -- so the earlier claim that this "actually happened"
    // to it was unsupported and has been removed).
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    const slug = 'pg-d1-hard-deleted';
    const page = {
      type: 'concept', title: 'PG D1 Hard Deleted', compiled_truth: 'original body', timeline: '', frontmatter: {},
    } as const;

    await engine.putPage(slug, page, { sourceId: 'default' });
    // Simulate the hard purge landing in the write gap: no row survives for
    // ON CONFLICT to match against.
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]);

    const recreated = await engine.putPage(slug, {
      ...page, compiled_truth: 'recreated after hard purge',
    }, { sourceId: 'default' });
    expect(recreated.slug).toBe(slug);

    const raw = await engine.executeRaw<{ deleted_at: string | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(raw[0]?.deleted_at).toBeNull();
    expect(raw[0]?.compiled_truth).toBe('recreated after hard purge');
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
