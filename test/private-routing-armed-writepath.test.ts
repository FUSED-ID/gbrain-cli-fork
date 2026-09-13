import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';

const putPage = operationsByName.put_page;
const PERSON_CONTENT = '---\ntype: person\ntitle: Private Test Person\n---\n\nPerson body.\n';

let engine: PGLiteEngine;
let policyDir: string;

function writePolicy(excluded: string): void {
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(join(policyDir, '_excluded-people.md'), excluded);
}

async function pointPrivateSource(localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [localPath],
  );
}

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

async function executePutPage(slug: string): Promise<void> {
  await putPage.handler(putContext(), { slug, content: PERSON_CONTENT });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources
     SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{facts_visibility}', '"world"'::jsonb)
     WHERE id = 'default'`,
  );
}, 120_000);

beforeEach(async () => {
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-arm-writepath-'));
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'people/arm-writepath-%'`);
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
});

afterAll(async () => {
  await engine.disconnect();
  if (policyDir && existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
});

describe('private routing armed guard at the put_page write path', () => {
  test('throws when no private source resolves', async () => {
    await expect(executePutPage('people/arm-writepath-no-source')).rejects.toThrow(/NOT ARMED/);
  });

  test('throws when _excluded-people.md is unreadable', async () => {
    await pointPrivateSource(policyDir);
    mkdirSync(join(policyDir, '_excluded-people.md'));
    writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');

    await expect(executePutPage('people/arm-writepath-unreadable')).rejects.toThrow(/could not be read/);
  });

  test('throws when the Family deny-list heading is missing', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Renamed family section\n| Slug pattern | Name |\n|---|---|\n| `private-test*` | Private Test Person |\n');

    await expect(executePutPage('people/arm-writepath-renamed')).rejects.toThrow(/ZERO deny-list entries/);
  });

  test('rechecks the cached arm when a policy file changes', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `cache-person` | Cache Person |\n');

    await engine.putPage('people/arm-writepath-cache', {
      type: 'person',
      title: 'Cache Person',
      compiled_truth: 'Cached write.',
      timeline: '',
      frontmatter: {},
    });

    writeFileSync(join(policyDir, '_excluded-people.md'), '## Renamed family section\n');
    await expect(engine.putPage('people/arm-writepath-cache', {
      type: 'person',
      title: 'Cache Person',
      compiled_truth: 'Changed write.',
      timeline: '',
      frontmatter: {},
    })).rejects.toThrow(/ZERO deny-list entries/);
  });
});
