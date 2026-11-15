import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';

const sourceId = 'p4-overlay-floor-transition-1030';
let engine: BrainEngine;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema(); engine = lite;
  await engine.executeRaw('INSERT INTO sources(id,name,config) VALUES ($1,$1,$2::text::jsonb)',
    [sourceId, JSON.stringify({ federated: true, facts_visibility: 'world' })]);
}, 120_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

function fact(claim: string, extra: Partial<ParsedFact> = {}): ParsedFact {
  return { rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    active: true, context: 'Floor transition context', ...extra };
}

test('private-marked page: a world fence cell floored to private is struck by the stored private withdrawal', async () => {
  const claim = 'p4floortransition private page claim';
  const body = `Prose\n${renderFactsTable([fact(claim, { visibility: 'world' })])}`;
  await engine.putPage('p4-floor-private-page', { type: 'note', title: 'Private floor page', compiled_truth: body,
    frontmatter: { visibility: 'private' } }, { sourceId });
  const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'private' }, { source_id: sourceId });
  expect((await recordFactWithdrawal(engine, stored.id, sourceId)).withdrawn).toBe(true);
  const snapshot = (await engine.readPageSnapshot('p4-floor-private-page', { sourceId }))!;
  const rows = withdrawalFenceBlocks(snapshot.page.compiled_truth).flatMap(block => block.parsed.facts);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ active: false, forgotten: true, visibility: 'world' });
});

test('public page: a withdrawn world row does not strike an independent private row for the same claim', async () => {
  const claim = 'p4floortransition public page claim';
  const body = `Prose\n${renderFactsTable([
    fact(claim, { rowNum: 1, visibility: 'world' }),
    fact(claim, { rowNum: 2, visibility: 'private' }),
  ])}`;
  await engine.putPage('p4-floor-public-page', { type: 'note', title: 'Public floor page', compiled_truth: body }, { sourceId });
  const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: sourceId });
  expect((await recordFactWithdrawal(engine, stored.id, sourceId, true)).withdrawn).toBe(true);
  const snapshot = (await engine.readPageSnapshot('p4-floor-public-page', { sourceId }))!;
  const rows = withdrawalFenceBlocks(snapshot.page.compiled_truth).flatMap(block => block.parsed.facts);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ active: false, forgotten: true, visibility: 'world' });
  expect(rows[1]).toMatchObject({ active: true, visibility: 'private', forgotten: false });
});
