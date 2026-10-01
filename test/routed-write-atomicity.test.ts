import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

const putPage = operationsByName.put_page;
const SLUG = 'people/routed-write-atomicity-8d0c34be';
const PRIVATE_SLUG = 'people/routed-write-atomicity-resurrection-8d0c34be';
const DENY_LIST = `## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| \`routed-write-atomicity-*\` | Routed Write Atomicity Synthetic |\n`;
const POLICY = JSON.stringify({
  private_routing: {
    excluded_people_markdown: DENY_LIST,
    filing_rules_markdown: '# filing rules\n',
  },
});
const PAGE = {
  type: 'person',
  title: 'Routed Write Atomicity Synthetic',
  compiled_truth: 'synthetic routed write body',
  timeline: '',
  frontmatter: {},
} as const;

let engine: PGLiteEngine;
let brainDir: string;
let missingPrivateDir: string;

function countFiles(root: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    count += entry.isDirectory() ? countFiles(path) : 1;
  }
  return count;
}

async function pointMissingPrivateSource(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, $2::text::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [missingPrivateDir, POLICY],
  );
}

function context() {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function deleteProbeRows(): Promise<void> {
  await engine.executeRaw(
    `DELETE FROM pages WHERE slug IN ($1, $2)`,
    [SLUG, PRIVATE_SLUG],
  );
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
  const liveRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug IN ($1, $2)`,
    [SLUG, PRIVATE_SLUG],
  );
  expect(Number(liveRows[0]?.n ?? 0)).toBe(0);
}

async function pageCounts(slug: string): Promise<{ defaultRows: number; privateRows: number; versions: number; chunks: number }> {
  const rows = await engine.executeRaw<{ source_id: string; n: number }>(
    `SELECT source_id, COUNT(*)::int AS n FROM pages WHERE slug = $1 GROUP BY source_id`,
    [slug],
  );
  const versions = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = $1`,
    [slug],
  );
  const chunks = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1`,
    [slug],
  );
  return {
    defaultRows: Number(rows.find((row) => row.source_id === 'default')?.n ?? 0),
    privateRows: Number(rows.find((row) => row.source_id === 'lg-private')?.n ?? 0),
    versions: Number(versions[0]?.n ?? 0),
    chunks: Number(chunks[0]?.n ?? 0),
  };
}

beforeAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  resetGateway();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-routed-write-atomicity-brain-'));
  missingPrivateDir = join(tmpdir(), 'gbrain-routed-write-atomicity-private-missing');
  rmSync(missingPrivateDir, { recursive: true, force: true });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1, config = jsonb_set(COALESCE(config, '{}'::jsonb), '{facts_visibility}', '"world"'::jsonb) WHERE id = 'default'`,
    [brainDir],
  );
}, 120_000);

beforeEach(async () => {
  await deleteProbeRows();
  await pointMissingPrivateSource();
});

afterAll(async () => {
  await deleteProbeRows();
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('routed page write atomicity', () => {
  test('missing private repo refuses before creating any database or file artifact', async () => {
    const filesBefore = countFiles(brainDir);
    await expect(putPage.handler(context(), {
      slug: SLUG,
      content: '---\ntype: person\ntitle: Routed Write Atomicity Synthetic\n---\n\nNew synthetic body.\n',
    })).rejects.toThrow(/storage_error|repo_not_found|private source/i);

    const counts = await pageCounts(SLUG);
    expect(counts.defaultRows).toBe(0);
    expect(counts.privateRows).toBe(0);
    expect(counts.versions).toBe(0);
    expect(counts.chunks).toBe(0);
    expect(countFiles(brainDir)).toBe(filesBefore);
  });

  test('direct routed import also refuses before persisting a page', async () => {
    await expect(importFromContent(
      engine,
      SLUG,
      '---\ntype: person\ntitle: Routed Write Atomicity Synthetic\n---\n\nDirect synthetic import.\n',
      { sourceId: 'default', noEmbed: true },
    )).rejects.toThrow(/repo_not_found|preflight/i);
    expect(await pageCounts(SLUG)).toEqual({ defaultRows: 0, privateRows: 0, versions: 0, chunks: 0 });
  });

  test('missing private repo does not resurrect a soft-deleted private row', async () => {
    await engine.putPage(PRIVATE_SLUG, PAGE, { sourceId: 'lg-private' });
    await engine.softDeletePage(PRIVATE_SLUG, { sourceId: 'lg-private' });
    const before = await engine.executeRaw<{ deleted_at: Date | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE source_id = 'lg-private' AND slug = $1`,
      [PRIVATE_SLUG],
    );
    const deletedAt = before[0]?.deleted_at;

    await expect(putPage.handler(context(), {
      slug: PRIVATE_SLUG,
      content: '---\ntype: person\ntitle: Routed Write Atomicity Synthetic\n---\n\nAttempted resurrection.\n',
    })).rejects.toThrow(/storage_error|repo_not_found|private source/i);

    const after = await engine.executeRaw<{ deleted_at: Date | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE source_id = 'lg-private' AND slug = $1`,
      [PRIVATE_SLUG],
    );
    expect(after[0]?.deleted_at?.getTime()).toBe(deletedAt?.getTime());
    expect(after[0]?.compiled_truth).toBe('synthetic routed write body');
  });
});
