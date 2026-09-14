import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { assertPrivateRoutingArmed, resolvePrivateWriteSource } from '../src/core/private-source-routing.ts';

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

async function pointDatabasePrivateSource(): Promise<void> {
  const policy = JSON.stringify({
    private_routing: {
      excluded_people_markdown: '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `peer-person` | Peer Person |\n',
      filing_rules_markdown: '# filing rules\n',
    },
  });
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [null, policy],
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

    await assertPrivateRoutingArmed(engine);

    writeFileSync(join(policyDir, '_excluded-people.md'), '## Renamed family section\n');
    await expect(engine.putPage('people/arm-writepath-cache', {
      type: 'person',
      title: 'Cache Person',
      compiled_truth: 'Changed write.',
      timeline: '',
      frontmatter: {},
    })).rejects.toThrow(/ZERO deny-list entries/);
  });

  test('throws for the leaked singular person slug even when its type is concept', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('person/lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus/i);
  });

  test('refuses a person-shaped engine write to default even when ARMED', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('person/lgv', {
      type: 'concept',
      title: 'LGV',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus/i);
  });

  test('put_page routes a person prefix to an existing bare private slug', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('bare-existing-person', {
      type: 'concept',
      title: 'Bare Existing Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(putPage.handler(putContext(), {
      slug: 'person/bare-existing-person',
      content: '---\ntype: concept\ntitle: Bare Existing Person\n---\n\nRouted update.\n',
    })).resolves.toBeDefined();
    await expect(engine.getPage('bare-existing-person', { sourceId: 'lg-private' })).resolves.toBeDefined();
    await expect(engine.getPage('person/bare-existing-person', { sourceId: 'default' })).resolves.toBeNull();
  });

  test('catches a bare private copy behind the contacts prefix', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('contact-person', {
      type: 'concept',
      title: 'Contact Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('contacts/contact-person', {
      type: 'concept',
      title: 'Contact Person',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus|NOT ARMED/i);
  });

  test('catches a bare private copy behind the harvest prefix', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n');
    await engine.putPage('harvest-person', {
      type: 'concept',
      title: 'Harvest Person',
      compiled_truth: 'Private copy.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'lg-private' });

    await expect(engine.putPage('harvest/harvest-person', {
      type: 'concept',
      title: 'Harvest Person',
      compiled_truth: 'Leaked shape.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/routed source|world-federated|refus|NOT ARMED/i);
  });

  test('rechecks the private source row after a successful arm', async () => {
    await pointPrivateSource(policyDir);
    writePolicy('## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `arm-writepath-after-delete` | After Delete |\n');
    await executePutPage('people/arm-writepath-after-delete');

    await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
    await expect(executePutPage('people/arm-writepath-after-delete')).rejects.toThrow(/NOT ARMED/);
  });

  test('arms and routes from database-held policy without local policy files', async () => {
    await pointDatabasePrivateSource();
    const route = await resolvePrivateWriteSource(engine, {
      requestedSourceId: 'default',
      slug: 'people/peer-person',
      entityName: 'Peer Person',
      entityType: 'person',
    });
    expect(route.sourceId).toBe('lg-private');
    expect((await assertPrivateRoutingArmed(engine)).localPath).toBe('database:lg-private');

    await expect(putPage.handler(putContext(), {
      slug: 'people/peer-person',
      content: PERSON_CONTENT,
    })).resolves.toBeDefined();
    await expect(engine.getPage('people/peer-person', { sourceId: 'lg-private' })).resolves.toBeDefined();
  });
});
