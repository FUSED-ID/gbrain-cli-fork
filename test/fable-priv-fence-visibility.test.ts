import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';

const SOURCE = 'gf-private-fence';
const SLUG = 'notes/fable-fence-probe';
let engine: PGLiteEngine;

const fence = (notability: string) => `# Fence probe\n\nBody.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Fence row world | fact | 1.0 | world | ${notability} | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->\n`;

async function visibility(): Promise<string> {
  const rows = await engine.executeRaw<{ visibility: string }>(
    `SELECT visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL`,
    [SOURCE, SLUG],
  );
  return rows[0]?.visibility ?? '';
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, 'Fable private fence', $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config`,
    [SOURCE, JSON.stringify({ federated: false, facts_visibility: 'private' })],
  );
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts WHERE source_id=$1`, [SOURCE]);
  await engine.executeRaw(`DELETE FROM pages WHERE source_id=$1`, [SOURCE]);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('private-source fence visibility', () => {
  test('keeps a fence row private across an edit and does not drift-loop', async () => {
    await engine.putPage(SLUG, {
      type: 'note', title: 'Fence probe', compiled_truth: fence('medium'), timeline: '', frontmatter: {},
    }, { sourceId: SOURCE });
    await runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG] });
    await engine.executeRaw(`UPDATE facts SET visibility='private' WHERE source_id=$1 AND source_markdown_slug=$2`, [SOURCE, SLUG]);
    expect(await visibility()).toBe('private');

    await engine.putPage(SLUG, {
      type: 'note', title: 'Fence probe', compiled_truth: fence('high'), timeline: '', frontmatter: {},
    }, { sourceId: SOURCE });
    const edited = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG] });
    expect(await visibility()).toBe('private');
    expect(edited.factsUpdated).toBe(1);

    const stable = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG] });
    expect(await visibility()).toBe('private');
    expect(stable.factsUpdated).toBe(0);
  });
});
