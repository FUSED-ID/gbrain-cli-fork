import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  resolveSourceVisibility,
  tightenToPage,
} from '../src/core/facts/visibility.ts';

const SOURCE_FED = 'p4-floor-fed';
const SOURCE_PRIVATE = 'p4-floor-private';
const PAGE = 'p4-floor-page';
let engine: PGLiteEngine;

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
  await source(SOURCE_FED, { federated: true, facts_visibility: 'world' });
  await source(SOURCE_PRIVATE, { federated: false, facts_visibility: 'world' });
  await engine.putPage(PAGE, {
    type: 'note',
    title: PAGE,
    compiled_truth: 'private page body',
    timeline: '',
    frontmatter: { visibility: 'private' },
  }, { sourceId: SOURCE_FED });
  await engine.setConfig('facts.default_visibility', 'world');
});

afterAll(async () => {
  await engine?.disconnect();
});

describe('P4 source and page floors', () => {
  test('1 explicit world on a private derived page tightens to private', () => {
    expect(tightenToPage('world', {
      type: 'note',
      frontmatter: { visibility: 'private' },
    })).toBe('private');
  });

  test('2 unset plus non-federated source and world default is private', async () => {
    expect(await resolveSourceVisibility(engine, SOURCE_PRIVATE)).toBe('private');
  });

  test('3 missing source is private', async () => {
    expect(await resolveSourceVisibility(engine, 'p4-floor-missing', 'world')).toBe('private');
  });

  test('4 unreadable source is private', async () => {
    const broken = {
      executeRaw: async () => { throw new Error('source lookup failed'); },
    } as unknown as BrainEngine;
    expect(await resolveSourceVisibility(broken, SOURCE_FED, 'world')).toBe('private');
  });

  test('5 federated world policy fills unset on a public page', async () => {
    expect(await resolveSourceVisibility(engine, SOURCE_FED)).toBe('world');
  });

  test('6 source policy never overrides explicit private or world', async () => {
    expect(await resolveSourceVisibility(engine, SOURCE_FED, 'private')).toBe('private');
    expect(await resolveSourceVisibility(engine, SOURCE_FED, 'world')).toBe('world');
  });

  test('7 invalid caller value fails closed', async () => {
    expect(await resolveSourceVisibility(engine, SOURCE_FED, 'invalid')).toBe('private');
  });

  test('8 queued accepted world is re-tightened after source becomes private', async () => {
    await source('p4-floor-queued', { federated: true });
    expect(await resolveSourceVisibility(engine, 'p4-floor-queued', 'world')).toBe('world');
    await source('p4-floor-queued', { federated: false });
    expect(await resolveSourceVisibility(engine, 'p4-floor-queued', 'world')).toBe('private');
  });

  test('9 managed publication source floor admits only private', async () => {
    const fact = 'p4 managed publication floor';
    await engine.insertFact({
      fact,
      kind: 'fact',
      entity_slug: PAGE,
      source: 'test',
      visibility: 'world',
    }, { source_id: SOURCE_PRIVATE });
    expect(await current(SOURCE_PRIVATE, fact)).toBe('private');
  });
});
