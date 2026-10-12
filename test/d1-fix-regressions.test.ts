import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { importFromContent } from '../src/core/import-file.ts';

const SLUG = 'wiki/g-pavlov-kuna-family';
const TITLE = 'G Pavlov-Kuna Family';
const DENY = `## Family deny-list
| Slug pattern | Name |
|---|---|
| \`wiki/g-pavlov-kuna-family\` | ${TITLE} |
`;
const BODY = `# ${TITLE}

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A family fact | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |
<!--- gbrain:facts:end -->
`;

let engine: PGLiteEngine;
let brainDir: string;
let privateDir: string;

async function seedDefaultPage(): Promise<number> {
  await engine.putPage(SLUG, {
    type: 'note', title: TITLE, compiled_truth: BODY, timeline: '', frontmatter: {},
    source_path: `${SLUG}.md`,
  }, { sourceId: 'default', migrationWrite: true });
  mkdirSync(join(brainDir, 'wiki'), { recursive: true });
  writeFileSync(join(brainDir, `${SLUG}.md`), BODY);
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source,
                        row_num, source_markdown_slug, valid_from)
     VALUES ('default', $1, 'A family fact', 'fact', 'world', 'test', 1, $1, '2026-01-01')
     RETURNING id`,
    [SLUG],
  );
  return Number(rows[0].id);
}

beforeAll(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-d1-fix-brain-'));
  privateDir = mkdtempSync(join(tmpdir(), 'gbrain-d1-fix-private-'));
  writeFileSync(join(privateDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(join(privateDir, '_excluded-people.md'), DENY);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1,
       config = jsonb_set(jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb), '{facts_visibility}', '"world"'::jsonb)
     WHERE id = 'default'`,
    [brainDir],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [privateDir],
  );
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts WHERE source_markdown_slug = $1 OR entity_slug = $1`, [SLUG]);
  await engine.executeRaw(`DELETE FROM pages WHERE slug = $1`, [SLUG]);
  rmSync(join(brainDir, 'wiki'), { recursive: true, force: true });
});

afterAll(async () => {
  await engine.disconnect();
  if (existsSync(brainDir)) rmSync(brainDir, { recursive: true, force: true });
  if (existsSync(privateDir)) rmSync(privateDir, { recursive: true, force: true });
});

describe('D1 exposure-reducing writes and routed reconciliation', () => {
  test('forget_fact withdraws a leaked world fact; the body write stays D1-guarded and no file bytes are copied', async () => {
    const id = await seedDefaultPage();
    // Bytes that exist only in the file (drift). A forget must never copy the
    // file into the indexed page.
    const DRIFT = 'DRIFT-ONLY-IN-FILE';
    writeFileSync(join(brainDir, `${SLUG}.md`), `${BODY}\n${DRIFT}\n`);
    const [before] = await engine.executeRaw<{ compiled_truth: string; content_hash: string }>(
      `SELECT compiled_truth, content_hash FROM pages WHERE source_id = 'default' AND slug = $1`, [SLUG]);

    const result = await forgetFactInFence(engine, id, { reason: 'D1 regression' });

    // Upstream v0.57 withdrawal model: a durable withdrawal record, the facts
    // row expired, the fence file struck, and reads render the claim withdrawn.
    expect(result).toMatchObject({ ok: true, path: 'fence' });
    const fact = await engine.executeRaw<{ expired_at: Date | null }>(
      'SELECT expired_at FROM facts WHERE id = $1', [id],
    );
    expect(fact[0].expired_at).not.toBeNull();
    const withdrawals = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM fact_withdrawals WHERE source_id = 'default'`);
    expect(Number(withdrawals[0].n)).toBe(1);
    const file = readFileSync(join(brainDir, `${SLUG}.md`), 'utf8');
    expect(file).toContain('~~A family fact~~');
    const rendered = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(rendered?.compiled_truth).toContain('~~A family fact~~');

    // Fork D1 rule 1: no raw file-byte copy into the indexed page.
    expect(rendered?.compiled_truth).not.toContain(DRIFT);
    // Fork D1 rule 2: the body write goes through the D1-guarded chokepoint.
    // This page is deny-listed in a world-federated source, so the guard
    // refuses forget's body strike and the stored body/hash are unchanged.
    const [after] = await engine.executeRaw<{ compiled_truth: string; content_hash: string }>(
      `SELECT compiled_truth, content_hash FROM pages WHERE source_id = 'default' AND slug = $1`, [SLUG]);
    expect(after.compiled_truth).toBe(before.compiled_truth);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.compiled_truth).not.toContain(DRIFT);
  });

  test('a routed put tombstones the exposed default copy and writes private content', async () => {
    await engine.putPage(SLUG, {
      type: 'note', title: TITLE, compiled_truth: 'Leaked body', timeline: '', frontmatter: {},
    }, { sourceId: 'default', migrationWrite: true });

    const content = `---\ntype: note\ntitle: ${TITLE}\n---\n\nPrivate replacement.\n`;
    const result = await importFromContent(engine, SLUG, content, { sourceId: 'default', noEmbed: true });

    expect(result.status).toBe('imported');
    await expect(engine.getPage(SLUG, { sourceId: 'lg-private' })).resolves.toMatchObject({
      source_id: 'lg-private', compiled_truth: 'Private replacement.',
    });
    await expect(engine.getPage(SLUG, { sourceId: 'default' })).resolves.toBeNull();
    await expect(engine.getPage(SLUG, { sourceId: 'default', includeDeleted: true })).resolves.toMatchObject({
      source_id: 'default', deleted_at: expect.anything(), compiled_truth: 'Leaked body',
    });
  });
});
