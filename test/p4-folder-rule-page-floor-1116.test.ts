/**
 * TD-P4-FOLDER-RULES (2026-11-16): the fork P4 floor (no fact wider than its page) covers
 * GBRA-218 folder rules. An explicit world fact on a public page under a folder rule is
 * stored private by the insert chokepoint (pageFloor through floorVisibility) and by the
 * batch floor (floorFactRows), the same answer the withdrawal floor computes: flooredClaimSql
 * in facts/withdrawal.ts runs derivationPrivateSql over the newest live page row.
 * A public page outside any rule still stores world. PGLite, repo-less, keyless.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { derivationPrivateSql } from '../src/core/search/private-visibility.ts';
import { floorFactRows } from '../src/core/engine-sql/facts.ts';

const SRC = 'p4-folder-floor';
const SECRET = 'partners/secret-example/';
const RULED = SECRET + 'plan';
const OPEN = 'concepts/open-plan';
let engine: PGLiteEngine;

async function stored(fact: string): Promise<string> {
  const rows = await engine.executeRaw<{ visibility: string }>(
    'SELECT visibility FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id DESC LIMIT 1', [SRC, fact]);
  return rows[0]?.visibility ?? '';
}

/** The page half of flooredClaimSql (withdrawal.ts): the same derived table and predicate. */
async function withdrawalFloorPrivate(slug: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ p: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM (SELECT type, frontmatter, source_id, slug, folder_rule_ids FROM pages
       WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) pf
     WHERE ${derivationPrivateSql('pf')}) AS p`, [SRC, slug]);
  return row?.p === true;
}

async function insertWorld(fact: string, slug: string): Promise<void> {
  await engine.insertFact({ fact, kind: 'fact', entity_slug: slug, source: 'test', visibility: 'world' }, { source_id: SRC });
}

describe('P4 page floor under a folder rule (pglite, repo-less)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)',
      [SRC, JSON.stringify({ federated: true, facts_visibility: 'world' })]);
    await engine.setConfig('facts.default_visibility', 'world');
    await proposeRevision(engine, SRC, [{ id: 'secret', prefix: SECRET, readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
    for (const slug of [RULED, OPEN]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'plan body', timeline: '', frontmatter: { visibility: 'world' } }, { sourceId: SRC });
    }
  }, 120_000);
  afterAll(async () => {
    await engine?.disconnect();
  });

  test('precondition: the ruled page carries the rule stamp and the withdrawal floor reads it private; the open page does not', async () => {
    const rows = await engine.executeRaw<{ slug: string; ruled: boolean }>(
      'SELECT slug, folder_rule_ids IS NOT NULL AS ruled FROM pages WHERE source_id = $1 ORDER BY slug', [SRC]);
    expect(rows).toEqual([{ slug: OPEN, ruled: false }, { slug: RULED, ruled: true }]);
    expect(await withdrawalFloorPrivate(RULED)).toBe(true);
    expect(await withdrawalFloorPrivate(OPEN)).toBe(false);
  }, 60_000);

  test('an explicit world fact on a page under a folder rule is stored private, as the withdrawal floor computes', async () => {
    const fact = 'p4 folder floor ruled explicit world';
    await insertWorld(fact, RULED);
    expect(await stored(fact)).toBe('private');
  }, 60_000);

  test('the batch floor (floorFactRows) tightens a world row on the ruled page to private', async () => {
    const out = await floorFactRows(engine, SRC, RULED, [{ visibility: 'world' as const }]);
    expect(out.map(r => String(r.visibility))).toEqual(['private']);
  }, 60_000);

  test('control: an explicit world fact on a public page outside any rule stays world', async () => {
    const fact = 'p4 folder floor open explicit world';
    await insertWorld(fact, OPEN);
    expect(await stored(fact)).toBe('world');
    const out = await floorFactRows(engine, SRC, OPEN, [{ visibility: 'world' as const }]);
    expect(out.map(r => String(r.visibility))).toEqual(['world']);
  }, 60_000);
});
