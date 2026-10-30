import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const SOURCE_FED = 'p4-pagefault-fed';
const PAGE = 'p4-pagefault-public';
const PAGE_FLOOR_SQL = 'SELECT type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1';
let engine: PGLiteEngine;
let pageQueryFault = false;
let restoreQuery: (() => void) | null = null;

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

async function source(id: string, config: Record<string, unknown>) {
  await engine.executeRaw(
    'INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, archived=false',
    [id, JSON.stringify(config)],
  );
}

async function current(sourceId: string, fact: string): Promise<string> {
  const rows = await engine.executeRaw<{ visibility: string }>(
    'SELECT visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id DESC LIMIT 1',
    [sourceId, fact],
  );
  return rows[0]?.visibility ?? '';
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const db = engine.db as unknown as { query: QueryFn };
  const instrumented = db.query;
  db.query = (sql: string, params?: unknown[]) => {
    if (pageQueryFault && sql === PAGE_FLOOR_SQL) {
      return Promise.reject(new Error('page floor query failed'));
    }
    return instrumented(sql, params);
  };
  restoreQuery = () => { db.query = instrumented; };
  await source(SOURCE_FED, { federated: true, facts_visibility: 'world' });
  await engine.putPage(PAGE, {
    type: 'note',
    title: PAGE,
    compiled_truth: 'public page body',
    timeline: '',
    frontmatter: { visibility: 'world' },
  }, { sourceId: SOURCE_FED });
  await engine.setConfig('facts.default_visibility', 'world');
});

afterAll(async () => {
  pageQueryFault = false;
  restoreQuery?.();
  await engine?.disconnect();
});

describe('P4 page floor query fault', () => {
  test('no fault on a public page stores world', async () => {
    pageQueryFault = false;
    const fact = 'p4 pagefault public control';
    await engine.insertFact({
      fact,
      kind: 'fact',
      entity_slug: PAGE,
      source: 'test',
      visibility: 'world',
    }, { source_id: SOURCE_FED });
    expect(await current(SOURCE_FED, fact)).toBe('world');
  });

  test('a slug with no page row stores world', async () => {
    pageQueryFault = false;
    const fact = 'p4 pagefault missing page control';
    await engine.insertFact({
      fact,
      kind: 'fact',
      entity_slug: 'p4-pagefault-missing',
      source: 'test',
      visibility: 'world',
    }, { source_id: SOURCE_FED });
    expect(await current(SOURCE_FED, fact)).toBe('world');
  });

  test('a page query error forces private', async () => {
    pageQueryFault = true;
    try {
      const fact = 'p4 pagefault thrown page query';
      await engine.insertFact({
        fact,
        kind: 'fact',
        entity_slug: PAGE,
        source: 'test',
        visibility: 'world',
      }, { source_id: SOURCE_FED });
      expect(await current(SOURCE_FED, fact)).toBe('private');
    } finally {
      pageQueryFault = false;
    }
  });
});
