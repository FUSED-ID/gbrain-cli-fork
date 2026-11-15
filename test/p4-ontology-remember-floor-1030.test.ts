/**
 * P4 floors on the write paths that bypassed them (1030 lane).
 *
 * Ontology facts (`mergeOntologyFact`) and local `remember` must apply the same
 * source and page floors the other fact inserts apply:
 *
 *  a. An ontology observation with explicit world on a source that is not
 *     federated is stored private.
 *  b. The same observation on a federated world source, from a private
 *     provenance page, is stored private.
 *  c. Control: a federated world source with a public provenance page stays world.
 *  d. A local remember whose params name a non-federated source, while the
 *     caller context names a federated world source, is stored private. The
 *     floor follows the source the row is written into, not ctx.sourceId.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolve } from 'node:path';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const FED = 'p4cd-fed';
const UNSET = 'p4cd-unset';
const PUBLIC_PAGE = 'notes/public-journal';
const PRIVATE_PAGE = 'notes/private-journal';
let engine: PGLiteEngine;

async function source(id: string, config: Record<string, unknown>) {
  await engine.executeRaw(
    'INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb) ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, archived=false',
    [id, JSON.stringify(config)],
  );
}

async function visibilityOf(id: number | string): Promise<{ visibility: string; source_id: string }> {
  const rows = await engine.executeRaw<{ visibility: string; source_id: string }>(
    'SELECT visibility, source_id FROM facts WHERE id=$1',
    [Number(id)],
  );
  return rows[0] ?? { visibility: '', source_id: '' };
}

beforeAll(async () => {
  // The lane runner passes GBRAIN_HOME with a '..' segment; config rejects that, so normalize it here.
  if (process.env.GBRAIN_HOME) process.env.GBRAIN_HOME = resolve(process.env.GBRAIN_HOME);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await source(FED, { federated: true, facts_visibility: 'world' });
  await source(UNSET, {});
  await engine.putPage(PUBLIC_PAGE, {
    type: 'note', title: PUBLIC_PAGE, compiled_truth: 'public journal', timeline: '', frontmatter: {},
  }, { sourceId: FED });
  await engine.putPage(PRIVATE_PAGE, {
    type: 'note', title: PRIVATE_PAGE, compiled_truth: 'private journal', timeline: '', frontmatter: { visibility: 'private' },
  }, { sourceId: FED });
  await engine.putPage('people/p4cd-carol', {
    type: 'person', title: 'Carol', compiled_truth: 'A person.', timeline: '', frontmatter: {},
  }, { sourceId: UNSET });
  await engine.putPage('people/p4cd-dan', {
    type: 'person', title: 'Dan', compiled_truth: 'A person.', timeline: '', frontmatter: {},
  }, { sourceId: FED });
});

afterAll(async () => {
  await engine?.disconnect();
});

describe('P4 floors on ontology merge and local remember', () => {
  test('a world observation on a non-federated source is stored private', async () => {
    const res = await engine.mergeOntologyFact({
      sourceId: UNSET, entitySlug: 'people/p4cd-a', dimension: 'role', value: 'advisor',
      source: PUBLIC_PAGE, visibility: 'world',
    });
    expect(res.factId).not.toBeNull();
    expect(await visibilityOf(res.factId!)).toMatchObject({ visibility: 'private', source_id: UNSET });
  });

  test('a world observation from a private provenance page is stored private', async () => {
    const res = await engine.mergeOntologyFact({
      sourceId: FED, entitySlug: 'people/p4cd-b', dimension: 'role', value: 'advisor',
      source: PRIVATE_PAGE, visibility: 'world',
    });
    expect(res.factId).not.toBeNull();
    expect(await visibilityOf(res.factId!)).toMatchObject({ visibility: 'private', source_id: FED });
  });

  test('control: a world observation on a federated source from a public page stays world', async () => {
    const res = await engine.mergeOntologyFact({
      sourceId: FED, entitySlug: 'people/p4cd-c', dimension: 'role', value: 'advisor',
      source: PUBLIC_PAGE, visibility: 'world',
    });
    expect(res.factId).not.toBeNull();
    expect(await visibilityOf(res.factId!)).toMatchObject({ visibility: 'world', source_id: FED });
  });

  test('local remember writing to a non-federated source_id floors to that source, not ctx.sourceId', async () => {
    const ctx = {
      engine, remote: false, sourceId: FED, config: { engine: engine.kind }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as OperationContext;
    const out = await operationsByName.remember!.handler(ctx, {
      fact: 'Carol advises the team', provenance: 'test', entity: 'people/p4cd-carol',
      visibility: 'world', source_id: UNSET,
    }) as Record<string, unknown>;
    expect(out.id).toBeDefined();
    expect(await visibilityOf(out.id as number)).toMatchObject({ visibility: 'private', source_id: UNSET });
  });

  test('local remember writing to a federated world source_id from a non-federated ctx.sourceId stays world', async () => {
    const ctx = {
      engine, remote: false, sourceId: UNSET, config: { engine: engine.kind }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as OperationContext;
    const out = await operationsByName.remember!.handler(ctx, {
      fact: 'Dan advises the team', provenance: 'test', entity: 'people/p4cd-dan',
      visibility: 'world', source_id: FED,
    }) as Record<string, unknown>;
    expect(out.id).toBeDefined();
    expect(await visibilityOf(out.id as number)).toMatchObject({ visibility: 'world', source_id: FED });
  });
});
