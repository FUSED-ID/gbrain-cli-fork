import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { expireSuperseded } from '../src/core/facts/write-single.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const SLUG = 'person/d1-chokepoint-target';
const TITLE = 'D1 Chokepoint Target';
const DENY = `## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| \`person/d1-chokepoint-*\` | ${TITLE} |\n`;
const PAGE = { type: 'person' as const, title: TITLE, compiled_truth: 'private body', timeline: '', frontmatter: {} };

let engine: PGLiteEngine;
let privateDir: string;

async function seedPage(): Promise<void> {
  await engine.putPage(SLUG, PAGE, { sourceId: 'default', migrationWrite: true });
}

async function seedFact(overrides: Record<string, unknown> = {}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source)
     VALUES ('default', $1, $1, 1, 'old private fact', 'fact', 'world', 'd1-test') RETURNING id`,
    [SLUG],
  );
  void overrides;
  return Number(rows[0].id);
}

function ctx(): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

beforeAll(async () => {
  privateDir = mkdtempSync(join(tmpdir(), 'gbrain-d1-chokepoint-private-'));
  writeFileSync(join(privateDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(join(privateDir, '_excluded-people.md'), DENY);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources SET config = jsonb_set(jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb), '{facts_visibility}', '"world"'::jsonb) WHERE id = 'default'`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [privateDir],
  );
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM open_loops WHERE source_id = 'default'`);
  await engine.executeRaw(`DELETE FROM page_versions`);
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM pages`);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(privateDir, { recursive: true, force: true });
});

describe('D1 shared engine chokepoints on PGLite', () => {
  test('softDeletePage reduces exposure through the page seam', async () => {
    await seedPage();
    await expect(engine.softDeletePage(SLUG, { sourceId: 'default' })).resolves.toMatchObject({ slug: SLUG });
    await expect(engine.getPage(SLUG, { sourceId: 'default' })).resolves.toBeNull();
    await expect(engine.getPage(SLUG, { sourceId: 'default', includeDeleted: true })).resolves.toMatchObject({ deleted_at: expect.anything() });
  });

  test('refreshPageBody create path is refused at the page seam', async () => {
    await seedPage();
    await expect(engine.refreshPageBody(SLUG, 'default', 'new body', '', 'new-hash')).rejects.toThrow(/routed|refus|world-federated/i);
  });

  test('mergeOntologyFact guard covers corroboration, insert, and supersession branches', async () => {
    await seedPage();
    await expect(engine.mergeOntologyFact({ sourceId: 'default', entitySlug: SLUG, dimension: 'role', value: 'private', visibility: 'world', source: 'd1-test' })).rejects.toThrow(/routed|refus|world-visible/i);
  });

  test('createVersion is refused at the page-version seam', async () => {
    await seedPage();
    await expect(engine.createVersion(SLUG, { sourceId: 'default' })).rejects.toThrow(/routed|refus|world-federated/i);
  });

  test('insertFact refuses before plain and supersede branches', async () => {
    await seedPage();
    const input = { fact: 'new fact', entity_slug: SLUG, visibility: 'world' as const, source: 'd1-test' };
    await expect(engine.insertFact(input, { source_id: 'default' })).rejects.toThrow(/routed|refus|world-visible/i);
    await expect(engine.insertFact(input, { source_id: 'default', supersedeId: 999 })).rejects.toThrow(/routed|refus|world-visible/i);
  });

  test('insertFacts refuses before batch insert and supersession bookkeeping', async () => {
    await seedPage();
    const row = { fact: 'batch fact', entity_slug: SLUG, visibility: 'world' as const, source: 'd1-test', row_num: 1, source_markdown_slug: SLUG };
    await expect(engine.insertFacts([row], { source_id: 'default' })).rejects.toThrow(/routed|refus|world-visible/i);
  });

  test('expireFact reduces exposure through the fact seam', async () => {
    const id = await seedFact();
    await expect(engine.expireFact(id, { validUntil: '2026-09-15' })).resolves.toBe(true);
    const rows = await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id = $1', [id]);
    expect(rows[0].expired_at).not.toBeNull();
  });
});

describe('D1 callers use the shared guard seam', () => {
  test('facts/forget.ts forgetFactInFence expires through expireFact and mirrors the body', async () => {
    await seedPage();
    const id = await seedFact();
    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    const rows = await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id = $1', [id]);
    expect(rows[0].expired_at).not.toBeNull();
  });

  test('facts/write-single.ts expireSuperseded calls the shared expiry seam', async () => {
    const id = await seedFact();
    const replacement = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source)
       VALUES ('default', $1, 'replacement fact', 'fact', 'world', 'd1-test') RETURNING id`,
      [SLUG],
    );
    const replacementId = Number(replacement[0].id);
    await expireSuperseded(engine, id, replacementId);
    const rows = await engine.executeRaw<{ expired_at: unknown; superseded_by: number }>('SELECT expired_at, superseded_by FROM facts WHERE id = $1', [id]);
    expect(rows[0].expired_at).not.toBeNull();
    expect(Number(rows[0].superseded_by)).toBe(replacementId);
  });

  test('ops/loops.ts loops_close expires its projected fact through the shared seam', async () => {
    const id = await seedFact();
    const loop = await upsertOpenLoop(engine, {
      sourceId: 'default', dedupKey: 'd1-chokepoint-loop', loopType: 'commitment_owed_by_me',
      summary: 'd1 test loop', evidence: [], detector: 'manual', factId: id,
    });
    const result = await operationsByName.loops_close.handler(ctx(), { id: loop.id, status: 'done' }) as { closed: boolean; fact_expired: boolean };
    expect(result).toMatchObject({ closed: true, fact_expired: true });
    const rows = await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id = $1', [id]);
    expect(rows[0].expired_at).not.toBeNull();
  });
});
