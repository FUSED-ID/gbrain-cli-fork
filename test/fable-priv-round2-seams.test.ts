import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';

const putPage = operationsByName.put_page;
const PERSON_CONTENT = '---\ntype: person\ntitle: Fable Round 2\n---\n\nPrivate body.\n';

let engine: PGLiteEngine;
let policyDir: string;

function putContext() {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function setDefaultVisibility(federated: boolean, visibility: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = jsonb_set(jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', $1::jsonb), '{facts_visibility}', $2::jsonb) WHERE id='default'`,
    [JSON.stringify(federated), JSON.stringify(visibility)],
  );
}

beforeAll(async () => {
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-fable-priv-2-'));
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(join(policyDir, '_excluded-people.md'), '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `people/fable-round2-*` | Fable Round 2 |\n');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources SET config = jsonb_set(jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb), '{facts_visibility}', '"world"'::jsonb) WHERE id='default'`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path=EXCLUDED.local_path, config=EXCLUDED.config`,
    [policyDir],
  );
});

beforeEach(async () => {
  await setDefaultVisibility(true, 'world');
  await engine.executeRaw(`DELETE FROM page_versions`);
  await engine.executeRaw(`DELETE FROM pages`);
  await engine.executeRaw(`DELETE FROM persistence_source_bindings`);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(policyDir, { recursive: true, force: true });
});

describe('Fable round 2 private-port seams', () => {
  test('put_page rejects a private-routed person before submitPageMutation', async () => {
    await expect(putPage.handler(putContext(), {
      slug: 'people/fable-round2-put',
      content: PERSON_CONTENT,
    })).rejects.toThrow(/private-write routing is ARMED.*must land in private source/);
  });

  test('revertToVersion rejects a private-routed page at the engine seam', async () => {
    const slug = 'people/fable-round2-revert';
    await setDefaultVisibility(false, 'private');
    await engine.putPage(slug, {
      type: 'person', title: 'Fable Round 2', compiled_truth: 'v1', timeline: '', frontmatter: {},
    });
    const version = await engine.createVersion(slug, { sourceId: 'default' });
    await engine.putPage(slug, {
      type: 'person', title: 'Fable Round 2', compiled_truth: 'v2', timeline: '', frontmatter: {},
    });
    await setDefaultVisibility(true, 'world');

    await expect(engine.revertToVersion(slug, Number(version.id), { sourceId: 'default' }))
      .rejects.toThrow(/private-write routing is ARMED.*must land in private source/);
  });
});
