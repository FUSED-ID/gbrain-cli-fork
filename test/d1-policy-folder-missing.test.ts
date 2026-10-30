import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  assertPrivateRoutingArmed,
  resolvePrivateWriteSource,
  shouldAssertPrivateRouting,
} from '../src/core/private-source-routing.ts';

// Same policy documents as writePolicy in test/private-source-routing.test.ts.
// They live in the private source config, which is the database-held copy.
const FILING = '# private filing rules\n';
const EXCLUDED = `# Excluded People

## Family deny-list

| Slug pattern | Name | Relationship | DOB |
|---|---|---|---|
| \`private-person*\` | Private Person | Example | -

## NOT on this list

| Name | Reason SHARED |
|---|---|
| Shared Contact | business contact |
`;

const DENY_LISTED_WRITE = {
  requestedSourceId: 'default',
  slug: 'wiki/private-person-canary/_author',
  content: '---\ntype: person\nfull_name: Private Person\n---\n# Private Person\n',
};

let engine: PGLiteEngine;

function policyConfig(): string {
  return JSON.stringify({
    private_routing: {
      excluded_people_markdown: EXCLUDED,
      filing_rules_markdown: FILING,
    },
  });
}

async function seedPrivate(localPath: string): Promise<void> {
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private', 'Private', $1, $2::jsonb)`,
    [localPath, policyConfig()],
  );
}

function writeIdenticalPolicy(dir: string): void {
  writeFileSync(join(dir, '_brain-filing-rules.md'), FILING);
  writeFileSync(join(dir, '_excluded-people.md'), EXCLUDED);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `UPDATE sources
     SET config = jsonb_set(
       jsonb_set(COALESCE(config, '{}'::jsonb), '{federated}', 'true'::jsonb),
       '{facts_visibility}', '"world"'::jsonb
     )
     WHERE id = 'default'`,
  );
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('missing private policy folder', () => {
  test('a missing local_path folder does not route on the database policy and refuses to arm', async () => {
    const missing = join(tmpdir(), `gbrain-d1-policy-folder-missing-${process.pid}`);
    await seedPrivate(missing);
    expect(await shouldAssertPrivateRouting(engine, 'default')).toBe(true);

    const route = await resolvePrivateWriteSource(engine, DENY_LISTED_WRITE);
    let armedThrew = false;
    try {
      await assertPrivateRoutingArmed(engine);
    } catch {
      armedThrew = true;
    }

    expect({ routed: route.routed, sourceId: route.sourceId, armedThrew }).toEqual({
      routed: false,
      sourceId: 'default',
      armedThrew: true,
    });
  });

  test('the same deny-listed write routes when the folder holds identical documents', async () => {
    const present = join(tmpdir(), `gbrain-d1-policy-folder-present-${process.pid}`);
    mkdirSync(present, { recursive: true });
    writeIdenticalPolicy(present);
    await seedPrivate(present);

    const route = await resolvePrivateWriteSource(engine, DENY_LISTED_WRITE);
    expect(route.routed).toBe(true);
    expect(route.sourceId).toBe('lg-private');
    expect(route.reason).toBe('excluded_people_policy');
  });
});
