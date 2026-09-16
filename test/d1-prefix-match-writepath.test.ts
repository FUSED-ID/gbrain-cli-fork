import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const STAMP = '20260916';
const PROBE_MARKER = '-20260916';
const PROVIDER_KEYS = ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const savedEnv = new Map<string, string | undefined>();

let engine: PGLiteEngine;
let policyDir: string;

function writePolicy(): void {
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# private filing rules\n');
  writeFileSync(join(policyDir, '_excluded-people.md'), `# Excluded People

## Family deny-list

| Slug pattern | Name | Relationship | DOB |
|---|---|---|---|
| \`julie-anne-vandenberg\` | Julie Anne Vandenberg | Spouse | - |
| \`celeste-no-star\` | Celeste No Star | Family | - |
| \`marin-no-star\` | Marin No Star | Family | - |
| \`christophe-vandenberg*\` | Christophe Atticus Vandenberg | Son | - |
| \`william-vandenberg*\` | William Leonardo Vandenberg | Son | - |
| \`albert-bausch*\` | Albert Bausch | Family | - |
| \`g-pavlov-kuna-family*\` | G. Pavlov Kuna Family | Family | - |
`);
}

async function liveRows(): Promise<Array<{ source_id: string; slug: string }>> {
  return engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT source_id, slug FROM pages WHERE deleted_at IS NULL AND slug LIKE $1 ORDER BY source_id, slug`,
    [`%${PROBE_MARKER}%`],
  );
}

async function probe(slug: string): Promise<{ slug: string; outcome: string; rows: Array<{ source_id: string; slug: string }> }> {
  let outcome = 'allowed';
  try {
    await engine.putPage(slug, {
      type: 'person',
      title: 'Synthetic Probe Subject',
      compiled_truth: 'Synthetic probe content only.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
  } catch (error) {
    outcome = `refused: ${String(error).replace(/\s+/g, ' ').trim()}`;
  }
  return { slug, outcome, rows: await liveRows() };
}

beforeAll(async () => {
  for (const key of PROVIDER_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-prefix-writepath-'));
  writePolicy();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`
    UPDATE sources
    SET config = jsonb_set(jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb), '{facts_visibility}', '"world"'::jsonb)
    WHERE id = 'default'
  `);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'Synthetic private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [policyDir],
  );
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE $1`, [`%${PROBE_MARKER}%`]);
  expect(await liveRows()).toEqual([]);
});

afterEach(async () => {
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE $1`, [`%${PROBE_MARKER}%`]);
  const readBack = await liveRows();
  console.log(`CLEANUP READ-BACK: ${JSON.stringify(readBack)}`);
  expect(readBack).toEqual([]);
});

afterAll(async () => {
  await engine.disconnect();
  if (policyDir) rmSync(policyDir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('D1 synthetic write-path probes', () => {
  test('records the four prefix probes and leaves no live rows after cleanup', async () => {
    const cases = [
      `wiki/julie-anne-vandenberg-probe-b-${STAMP}`,
      `person/julie-anne-vandenberg-notes-${STAMP}`,
      `wiki/celeste-no-star-probe-${STAMP}`,
      `person/marin-no-star-notes-${STAMP}`,
    ];
    const results = [];
    for (const slug of cases) results.push(await probe(slug));
    for (const result of results) console.log(`PROBE ${result.slug}: ${result.outcome}; LIVE ${JSON.stringify(result.rows)}`);
    expect(results.every((result) => result.outcome.startsWith('refused:'))).toBe(true);
    expect(results.every((result) => result.rows.length === 0)).toBe(true);
  });

  test('keeps every wildcard entry refused and preserves three negative controls', async () => {
    const wildcards = [
      await probe(`wiki/christophe-vandenberg-probe-${STAMP}`),
      await probe(`wiki/william-vandenberg-probe-${STAMP}`),
      await probe(`wiki/albert-bausch-probe-${STAMP}`),
      await probe(`wiki/g-pavlov-kuna-family-probe-${STAMP}`),
    ];
    const ordinaryWord = await probe(`person/will-update-ordinary-word-${STAMP}`);
    const company = await probe(`person/vandenberg-energy-labs-${STAMP}`);
    const midString = await probe(`person/notes-about-julie-anne-vandenberg-${STAMP}`);
    console.log(`CONTROL wildcards ${JSON.stringify(wildcards)}`);
    console.log(`CONTROL negative ${JSON.stringify([ordinaryWord, company, midString])}`);
    expect(wildcards.every((result) => result.outcome.startsWith('refused:'))).toBe(true);
    expect(ordinaryWord.outcome).toBe('allowed');
    expect(company.outcome).toBe('allowed');
    expect(midString.outcome).toBe('allowed');
    expect(wildcards.every((result) => result.rows.length === 0)).toBe(true);
    expect(ordinaryWord.rows[0]?.source_id).toBe('default');
    expect(company.rows.some((row) => row.source_id === 'default')).toBe(true);
    expect(midString.rows.some((row) => row.source_id === 'default')).toBe(true);
  });
});
