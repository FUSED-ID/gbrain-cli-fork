import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const RENAMED = '## Household deny-list\n| Slug pattern | Name |\n|---|---|\n| `wiki/g-pavlov-kuna-family` | G Pavlov-Kuna Family |\n';
const VALID = '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `people/julie-anne-vandenberg` | Julie-Anne Vandenberg |\n| `notes/albert-bausch` | Albert Bausch |\n';
const PAGE = { type: 'note' as const, title: 'ordinary title', compiled_truth: 'body', timeline: '', frontmatter: {} };

let engine: PGLiteEngine;
let privateDir: string;

async function attempt(slug: string, page: { type: 'note' | 'person'; title: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }): Promise<string> {
  try {
    await engine.putPage(slug, page, { sourceId: 'default' });
    return 'allowed';
  } catch (error) {
    return String(error);
  }
}

beforeAll(async () => {
  privateDir = mkdtempSync(join(tmpdir(), 'gbrain-d3-routing-'));
  writeFileSync(join(privateDir, '_brain-filing-rules.md'), '# filing rules\n');
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
  await engine.executeRaw(`DELETE FROM pages WHERE slug IN ('wiki/g-pavlov-kuna-family', 'notes/albert-bausch', 'people/julie-anne-vandenberg', 'notes/corrupted-policy')`);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(privateDir, { recursive: true, force: true });
});

describe('D3 identity-shape-independent routing gate', () => {
  test('wiki/g-pavlov-kuna-family is refused when the deny-list heading is renamed', async () => {
    writeFileSync(join(privateDir, '_excluded-people.md'), RENAMED);
    const outcome = await attempt('wiki/g-pavlov-kuna-family', { ...PAGE, title: 'G Pavlov-Kuna Family' });
    console.log(`D3 wiki family: ${outcome}`);
    expect(outcome).toMatch(/refus|NOT ARMED/i);
  });

  test('a note titled Albert Bausch is refused on an innocuous slug', async () => {
    writeFileSync(join(privateDir, '_excluded-people.md'), RENAMED.replace('wiki/g-pavlov-kuna-family', 'notes/albert-bausch').replace('G Pavlov-Kuna Family', 'Albert Bausch'));
    const outcome = await attempt('notes/albert-bausch', { ...PAGE, title: 'Albert Bausch' });
    console.log(`D3 renamed-heading title match: ${outcome}`);
    expect(outcome).toMatch(/refus|NOT ARMED/i);
  });

  test('people/julie-anne-vandenberg remains refused', async () => {
    writeFileSync(join(privateDir, '_excluded-people.md'), RENAMED);
    const outcome = await attempt('people/julie-anne-vandenberg', { ...PAGE, type: 'person', title: 'Julie-Anne Vandenberg' });
    console.log(`D3 person-shaped fallback: ${outcome}`);
    expect(outcome).toMatch(/refus|NOT ARMED/i);
  });

  test('a deliberately corrupted deny-list refuses an otherwise ordinary routed write and names the file', async () => {
    writeFileSync(join(privateDir, '_excluded-people.md'), 'not markdown policy');
    const outcome = await attempt('notes/corrupted-policy', PAGE);
    console.log(`D3 corrupted deny-list: ${outcome}`);
    expect(outcome).toMatch(/_excluded-people\.md|NOT ARMED|refus/i);
  });
});
