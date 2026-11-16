/**
 * D1 routed put_page preflight (2026-11-16, Fable P1 on d1-round9 line 218).
 *
 * A local put_page on a deny-listed slug (excluded_people_policy) is moved to the private
 * source. The preflight must then check the guard against the routed source, so the write lands
 * in lg-private and the leaked default copy is tombstoned (excluded_people_policy and
 * unresolved_identity_policy). A remote put_page that the route sends to the private source is refused
 * by the preflight itself (its message, not only its code), including an allowlisted collision, where
 * the preflight is the only layer that refuses (Fable P2-1, 2026-11-16).
 */
import { afterAll, beforeAll, describe, expect, test as bunTest } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'd1put-home-test-'));
const policyDir = mkdtempSync(join(tmpdir(), 'd1put-policy-test-'));
const brainDir = mkdtempSync(join(tmpdir(), 'd1put-brain-test-'));
const allow = join(policyDir, 'allow.tsv');
const env = { GBRAIN_HOME: home, GBRAIN_PRIVACY_ALLOWLIST_PATH: allow };

const DENY = `## Family deny-list
| Slug pattern | Name |
|---|---|
| \`g-pavlov-kuna-family\` | G Pavlov Kuna Family |

## Do not enrich, identity unresolved
| Slug pattern | Name |
|---|---|
| \`wiki/mystery-relative-1116\` | Mystery Relative |
`;
const loaded = await withEnv(env, async () => {
  const engineMod = await import('../src/core/pglite-engine.ts');
  const opsMod = await import('../src/core/operations.ts');
  writeFileSync(join(policyDir, '_excluded-people.md'), DENY);
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(allow, 'collision|people/lgv\n');
  return { PGLiteEngine: engineMod.PGLiteEngine, operationsByName: opsMod.operationsByName };
});
const { PGLiteEngine, operationsByName } = loaded;

function test(name: string, fn: () => unknown, timeout?: number) {
  return bunTest(name, () => withEnv(env, () => fn()), timeout);
}

let engine: InstanceType<typeof PGLiteEngine>;
const SLUG = 'wiki/g-pavlov-kuna-family';
const content = (body: string) => `---\ntype: note\ntitle: G Pavlov Kuna Family\n---\n\n${body}\n`;
const ctx = (remote: boolean) => ({ engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default' } as any);

beforeAll(async () => {
  await withEnv(env, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`UPDATE sources SET local_path=$1, config = jsonb_set(jsonb_set(COALESCE(config,'{}'::jsonb),'{federated}','true'::jsonb),'{facts_visibility}','"world"'::jsonb) WHERE id='default'`, [brainDir]);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private','LG private',$1,'{}'::jsonb)`, [policyDir]);
  });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of [brainDir, policyDir, home]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('D1 routed put_page preflight checks the routed source', () => {
  test('a local put_page on a deny-listed slug lands in lg-private and tombstones the default copy', async () => {
    await engine.putPage(SLUG, { type: 'note', title: 'G Pavlov Kuna Family', compiled_truth: 'LEAKED FAMILY BODY', timeline: '', frontmatter: {} } as any,
      { sourceId: 'default', migrationWrite: true });
    await operationsByName.put_page.handler(ctx(false), { slug: SLUG, content: content('Private replacement.') });
    expect(await engine.getPage(SLUG, { sourceId: 'lg-private' })).toMatchObject({ source_id: 'lg-private', compiled_truth: 'Private replacement.' });
    expect(await engine.getPage(SLUG, { sourceId: 'default' })).toBeNull();
    expect(await engine.getPage(SLUG, { sourceId: 'default', includeDeleted: true })).toMatchObject({ deleted_at: expect.anything() });
  }, 120_000);

  test('a remote put_page routed to the private source is refused with permission_denied and writes nothing', async () => {
    const slug = 'notes/remote-routed-1116';
    const err = await Promise.resolve(operationsByName.put_page.handler(ctx(true), { slug, content: content('remote write.') }))
      .then(() => null, (e: unknown) => e as { code?: string });
    expect(err).not.toBeNull();
    expect(String(err?.code ?? err)).toContain('permission_denied');
    expect(String((err as { message?: string })?.message ?? '')).toContain('routed to private source');
    expect(await engine.getPage(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
    expect(await engine.getPage(slug, { sourceId: 'lg-private', includeDeleted: true })).toBeNull();
  }, 120_000);

  test('a local put_page on an unresolved-identity slug lands in lg-private and tombstones the default copy', async () => {
    const slug = 'wiki/mystery-relative-1116';
    await engine.putPage(slug, { type: 'note', title: 'Mystery Relative', compiled_truth: 'LEAKED RELATIVE BODY', timeline: '', frontmatter: {} } as any,
      { sourceId: 'default', migrationWrite: true });
    await operationsByName.put_page.handler(ctx(false), { slug, content: '---\ntype: note\ntitle: Mystery Relative\n---\n\nPrivate relative note.\n' });
    expect(await engine.getPage(slug, { sourceId: 'lg-private' })).toMatchObject({ source_id: 'lg-private', compiled_truth: 'Private relative note.' });
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    expect(await engine.getPage(slug, { sourceId: 'default', includeDeleted: true })).toMatchObject({ deleted_at: expect.anything() });
  }, 120_000);

  test('a remote put_page on an allowlisted collision is refused by the preflight and changes neither copy', async () => {
    const slug = 'people/lgv';
    await engine.putPage(slug, { type: 'person', title: 'LGV', compiled_truth: 'PRIVATE people/lgv', timeline: '', frontmatter: {} } as any, { sourceId: 'lg-private' });
    await engine.putPage(slug, { type: 'person', title: 'LGV', compiled_truth: 'PUBLIC people/lgv', timeline: '', frontmatter: {} } as any,
      { sourceId: 'default', migrationWrite: true });
    const err = await Promise.resolve(operationsByName.put_page.handler(ctx(true), { slug, content: '---\ntype: person\ntitle: LGV\n---\n\nremote overwrite.\n' }))
      .then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).not.toBeNull();
    expect(String(err?.code ?? err)).toContain('permission_denied');
    expect(String(err?.message ?? '')).toContain('routed to private source');
    expect(await engine.getPage(slug, { sourceId: 'lg-private' })).toMatchObject({ compiled_truth: 'PRIVATE people/lgv' });
    expect(await engine.getPage(slug, { sourceId: 'default' })).toMatchObject({ compiled_truth: 'PUBLIC people/lgv' });
  }, 120_000);
});
