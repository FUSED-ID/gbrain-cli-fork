import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import { resolvePrivateWriteSource, __privateSourceRoutingTest } from '../src/core/private-source-routing.ts';

function writePolicy(dir: string): void {
  writeFileSync(join(dir, '_brain-filing-rules.md'), '# private filing rules\n');
  writeFileSync(join(dir, '_excluded-people.md'), `# Excluded People

## Family deny-list

| Slug pattern | Name | Relationship | DOB |
|---|---|---|---|
| \`private-person*\` | Private Person | Example | - |

## NOT on this list

| Name | Reason SHARED |
|---|---|
| Shared Contact | business contact |
`);
}

function fakeEngine(privateDir: string, existingPrivateSlugs: string[] = []): BrainEngine {
  const existing = new Set(existingPrivateSlugs);
  return {
    getConfig: async () => null,
    executeRaw: async () => [
      { id: 'default', name: 'Default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      { id: 'lg-private', name: 'Private', local_path: privateDir, last_commit: null, last_sync_at: null, config: { federated: false }, created_at: new Date() },
    ],
    getPage: async (slug: string, opts?: { sourceId?: string }) =>
      opts?.sourceId === 'lg-private' && existing.has(slug)
        ? ({ slug, source_id: 'lg-private', type: 'person', title: slug } as Page)
        : null,
  } as unknown as BrainEngine;
}

describe('private source routing', () => {
  test('parses only the deny-list section', () => {
    const rows = __privateSourceRoutingTest.parseExcludedPeople(`## Family deny-list
| Slug pattern | Name |
|---|---|
| \`private-person*\` | Private Person |

## NOT on this list
| Name | Reason |
|---|---|
| Shared Contact | business |
`);
    expect(rows).toEqual([{ slugPattern: 'private-person*', name: 'Private Person' }]);
  });

  test('routes matching person author pages to private source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-routing-'));
    writePolicy(dir);
    const route = await resolvePrivateWriteSource(fakeEngine(dir), {
      requestedSourceId: 'default',
      slug: 'wiki/private-person-canary/_author',
      content: '---\ntype: person\nfull_name: Private Person\n---\n# Private Person\n',
    });
    expect(route.sourceId).toBe('lg-private');
    expect(route.reason).toBe('excluded_people_policy');
  });

  test('keeps known shared business contacts in requested source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-routing-'));
    writePolicy(dir);
    const route = await resolvePrivateWriteSource(fakeEngine(dir), {
      requestedSourceId: 'default',
      slug: 'wiki/shared-contact/_author',
      content: '---\ntype: person\nfull_name: Shared Contact\n---\n# Shared Contact\n',
    });
    expect(route.sourceId).toBe('default');
    expect(route.routed).toBe(false);
  });

  test('never downgrades an existing private same-slug page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-routing-'));
    writePolicy(dir);
    const route = await resolvePrivateWriteSource(fakeEngine(dir, ['people/other-person']), {
      requestedSourceId: 'default',
      slug: 'people/other-person',
      content: '---\ntype: person\n---\n# Other Person\n',
    });
    expect(route.sourceId).toBe('lg-private');
    expect(route.reason).toBe('existing_private_page');
  });
});
