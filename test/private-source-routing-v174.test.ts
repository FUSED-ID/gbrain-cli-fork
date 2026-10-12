import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  enforcePrivatePageWrite,
  assertPrivateRoutingArmed,
  parseExcludedPeople,
  parseUnresolvedIdentity,
  resolvePrivateWriteSource,
} from '../src/core/private-source-routing.ts';
import { resolveSourceVisibility } from '../src/core/facts/visibility.ts';

const excluded = `# policy\n\n## Family deny-list\n| slug | name |\n|---|---|\n| \`people/alice*\` | Alice Example |\n`;
const unresolved = `## Do not enrich, identity unresolved\n| slug | name |\n|---|---|\n| \`contacts/unknown*\` | Unknown Example |\n`;
const filing = '# filing rules\nKeep person pages in the private source.\n';

function fakeEngine() {
  const pages = new Set<string>();
  const sources = [
    { id: 'default', name: 'Default', local_path: null, config: { federated: true, facts_visibility: 'world' } },
    { id: 'lg-private', name: 'Private', local_path: null, config: {
      private_routing: { excluded_people_markdown: excluded, filing_rules_markdown: filing },
      federated: false, facts_visibility: 'private',
    } },
  ];
  return {
    pages,
    async listAllSources() { return sources; },
    async getConfig(key: string) { return key === 'facts.default_visibility' ? 'world' : null; },
    async getPage(slug: string, opts?: { sourceId?: string }) {
      return pages.has(`${opts?.sourceId ?? 'default'}:${slug}`) ? { type: 'person', title: 'Alice Example', source_id: opts?.sourceId ?? 'default' } : null;
    },
  } as any;
}

let realEngine: PGLiteEngine;
beforeAll(async () => {
  realEngine = new PGLiteEngine();
  await realEngine.connect({});
  await realEngine.initSchema();
  await realEngine.executeRaw(`UPDATE sources SET config = $1::jsonb WHERE id = 'default'`, [JSON.stringify({ federated: true, facts_visibility: 'world' })]);
  await realEngine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('lg-private', 'Private', $1::jsonb)`, [JSON.stringify({ federated: false, facts_visibility: 'private', private_routing: { excluded_people_markdown: excluded, filing_rules_markdown: filing } })]);
});

afterAll(async () => { await realEngine.disconnect(); });

describe('fork private-source routing guarantees on v0.60.174', () => {
  test('pins the family deny-list and unresolved-identity policy sections', () => {
    expect(parseExcludedPeople(excluded)).toHaveLength(1);
    expect(parseUnresolvedIdentity(unresolved)).toHaveLength(1);
  });

  test('routes a deny-listed person to lg-private and leaves an ordinary contact shared', async () => {
    const engine = fakeEngine();
    await expect(resolvePrivateWriteSource(engine, { requestedSourceId: 'default', slug: 'people/alice-example', entityType: 'person' }))
      .resolves.toMatchObject({ sourceId: 'lg-private', routed: true, reason: 'excluded_people_policy' });
    await expect(resolvePrivateWriteSource(engine, { requestedSourceId: 'default', slug: 'companies/acme', entityType: 'company' }))
      .resolves.toMatchObject({ sourceId: 'default', routed: false });
  });

  test('refuses the default person-page write even when the private page already exists', async () => {
    const engine = fakeEngine();
    engine.pages.add('lg-private:people/collision-person');
    engine.pages.add('lg-private:people/alice-example');
    await expect(enforcePrivatePageWrite(engine, {
      requestedSourceId: 'default', slug: 'people/alice-example', entityType: 'person', entityName: 'Alice Example',
    })).rejects.toThrow(/private source/);
  });

  test('allows only an exact, explicit public-stub collision and never a deny-list match', async () => {
    const engine = fakeEngine();
    engine.pages.add('lg-private:people/alice-example');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-routing-'));
    const path = join(dir, 'privacy-allowlist.tsv');
    writeFileSync(path, 'collision|people/collision-person\ncollision|people/alice-example\n');
    const prior = process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH;
    process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = path;
    try {
      const route = await resolvePrivateWriteSource(engine, { requestedSourceId: 'default', slug: 'people/collision-person', entityType: 'person' });
      expect(route.sourceId).toBe('default');
      expect(route.routed).toBe(false);
      const denied = await resolvePrivateWriteSource(engine, { requestedSourceId: 'default', slug: 'people/alice-example', entityType: 'person', entityName: 'Alice Example' });
      expect(denied.reason).toBe('excluded_people_policy');
    } finally {
      if (prior === undefined) delete process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH;
      else process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = prior;
    }
  });

  test('normalizes facts so world visibility never lands in a non-federated source', async () => {
    const engine = fakeEngine();
    await expect(resolveSourceVisibility(engine, 'default', 'world')).resolves.toBe('world');
    await expect(resolveSourceVisibility(engine, 'lg-private', 'world')).resolves.toBe('private');
    await expect(resolveSourceVisibility(engine, 'missing', 'world')).resolves.toBe('private');
  });

  test('engine page and fact write seams enforce the policy', async () => {
    await expect(realEngine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'private body', timeline: '', frontmatter: {},
    }, { sourceId: 'default' })).rejects.toThrow(/private source/);
    await expect(realEngine.putPage('notes/ordinary', {
      type: 'note', title: 'Ordinary', compiled_truth: 'ordinary body', timeline: '', frontmatter: {},
    }, { sourceId: 'default' })).resolves.toMatchObject({ slug: 'notes/ordinary' });
    const inserted = await realEngine.insertFact(
      { fact: 'clamped', entity_slug: 'notes/ordinary', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    const rows = await realEngine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id = $1', [inserted.id]);
    expect(rows[0]?.visibility).toBe('world');
    await realEngine.updateSourceConfig('default', { federated: false, facts_visibility: 'private' });
    const privateInserted = await realEngine.insertFact(
      { fact: 'must stay private', entity_slug: 'notes/ordinary', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    const privateRows = await realEngine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id = $1', [privateInserted.id]);
    expect(privateRows[0]?.visibility).toBe('private');
  });
});

describe('private policy disk/DB consistency', () => {
  function mismatchedEngine(dir: string) {
    return {
      async listAllSources() {
        return [
          { id: 'default', name: 'Default', local_path: null, config: { federated: true, facts_visibility: 'world' } },
          { id: 'lg-private', name: 'Private', local_path: dir, config: {
            private_routing: {
              excluded_people_markdown: '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `database-only` | Database Only |\n',
              filing_rules_markdown: filing,
            },
          } },
        ];
      },
      async getConfig() { return null; },
      async getPage() { return null; },
    } as any;
  }

  test('refuses to arm when database and on-disk policy documents differ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-routing-mismatch-'));
    writeFileSync(join(dir, '_excluded-people.md'), excluded);
    writeFileSync(join(dir, '_brain-filing-rules.md'), filing);
    await expect(assertPrivateRoutingArmed(mismatchedEngine(dir))).rejects.toThrow(/mismatch|on-disk/i);
  });

  test('warns and disables private routing when policy content mismatches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-routing-mismatch-warning-'));
    writeFileSync(join(dir, '_excluded-people.md'), excluded);
    writeFileSync(join(dir, '_brain-filing-rules.md'), filing);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const route = await resolvePrivateWriteSource(mismatchedEngine(dir), {
        requestedSourceId: 'default', slug: 'people/mismatch-warning', entityType: 'person',
      });
      expect(route.sourceId).toBe('default');
      expect(route.routed).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join('\n')).toMatch(/policy content mismatch.*lg-private/i);
  });
});
