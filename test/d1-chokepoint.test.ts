import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const DENY = '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `person/chokepoint-*` | Julie-Anne Vandenberg |\n';
const PERSON = {
  type: 'person' as const,
  title: 'Julie-Anne Vandenberg',
  compiled_truth: 'private body',
  timeline: '',
  frontmatter: {},
};

let engine: PGLiteEngine;
let policyDir: string;

async function seedPerson(slug = 'person/chokepoint-target'): Promise<void> {
  await engine.putPage(slug, PERSON, { sourceId: 'default', migrationWrite: true });
}

beforeAll(async () => {
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-d1-chokepoint-'));
  writeFileSync(join(policyDir, '_excluded-people.md'), DENY);
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources SET config = jsonb_set(jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb), '{facts_visibility}', '"world"'::jsonb) WHERE id = 'default'`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)`,
    [policyDir],
  );
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'person/chokepoint-%'`);
  await engine.executeRaw(`DELETE FROM facts WHERE entity_slug LIKE 'person/chokepoint-%'`);
});

afterAll(async () => {
  await engine.disconnect();
  if (existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
});

describe('D1 page/fact write chokepoints', () => {
  test('RED/GREEN: every page mutation seam loads type/title and refuses rule (a)', async () => {
    await seedPerson();
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['softDeletePage', () => engine.softDeletePage('person/chokepoint-target', { sourceId: 'default' })],
      ['softDeletePages', () => engine.softDeletePages(['person/chokepoint-target'], { sourceId: 'default' })],
      ['refreshPageBody', () => engine.refreshPageBody('person/chokepoint-target', 'default', 'new', '', 'hash')],
      ['createVersion', () => engine.createVersion('person/chokepoint-target', { sourceId: 'default' })],
      ['updateSlug', () => engine.updateSlug('person/chokepoint-target', 'person/chokepoint-renamed', { sourceId: 'default' })],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt()).rejects.toThrow(/private-write routing|world-federated|refus/i);
      console.log(`GREEN ${name}: refused by engine chokepoint`);
    }
  });

  test('RED/GREEN: fact insert, batch insert, expire, and ontology writes refuse rule (a)', async () => {
    await seedPerson();
    const input = { fact: 'Julie-Anne is private', entity_slug: 'person/chokepoint-target', visibility: 'world' as const, source: 'test' };
    await expect(engine.insertFact(input, { source_id: 'default' })).rejects.toThrow(/private-write routing|world-visible|refus/i);
    console.log('GREEN insertFact: refused by engine chokepoint');
    await expect(engine.insertFacts([{ ...input, row_num: 1, source_markdown_slug: 'person/chokepoint-target' }], { source_id: 'default' })).rejects.toThrow(/private-write routing|world-visible|refus/i);
    console.log('GREEN insertFacts: refused by engine chokepoint');

    const seeded = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ('default', 'person/chokepoint-target', 'old', 'fact', 'private', 'test') RETURNING id`,
    );
    await expect(engine.expireFact(Number(seeded[0].id))).rejects.toThrow(/private-write routing|refus/i);
    console.log('GREEN expireFact: refused by engine chokepoint');
    await expect(engine.mergeOntologyFact({
      sourceId: 'default', entitySlug: 'person/chokepoint-target', dimension: 'role', value: 'private', visibility: 'world', confidence: 1, source: 'test',
    })).rejects.toThrow(/private-write routing|world-visible|refus/i);
    console.log('GREEN mergeOntologyFact: refused by engine chokepoint');
  });
});
