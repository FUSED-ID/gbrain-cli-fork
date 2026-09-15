import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const revertVersion = operationsByName.revert_version;
const restorePage = operationsByName.restore_page;
const addTimelineEntry = operationsByName.add_timeline_entry;
if (!revertVersion || !restorePage || !addTimelineEntry) throw new Error('D1 bypass operations missing');

const ALLOWLIST_ENV = 'GBRAIN_PRIVACY_ALLOWLIST_PATH';
const DENYLIST = '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `d1-bypass-denylisted*` | D1 Bypass Denied |\n';
const PERSON_PAGE = { type: 'person' as const, title: 'D1 Bypass Denied', compiled_truth: 'person body', timeline: '', frontmatter: {} };
const ALLOWLISTED_COLLISIONS = [
  { slug: 'person/lgv', privateSlug: 'lgv' },
  { slug: 'wiki/chris-hooper/_author', privateSlug: 'chris-hooper' },
  { slug: 'chris-hooper/_author', privateSlug: 'chris-hooper' },
] as const;
const PAGE = { type: 'note' as const, title: 'D1 bypass test', compiled_truth: 'original body', timeline: '', frontmatter: {} };

let engine: PGLiteEngine;
let policyDir: string;
let allowlistPath: string;
let previousAllowlistPath: string | undefined;

function context(remote: boolean): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote,
    sourceId: 'default',
  } as OperationContext;
}

function writePolicy(): void {
  writeFileSync(join(policyDir, '_excluded-people.md'), DENYLIST);
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
}

async function addPrivateCollision(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note', title: 'Private collision', compiled_truth: `private body for ${slug}`, timeline: '', frontmatter: {},
  }, { sourceId: 'lg-private' });
}

async function seedDefault(slug: string): Promise<void> {
  await engine.putPage(slug, PAGE, { sourceId: 'default', migrationWrite: true });
}

async function seedDefaultPerson(slug: string): Promise<void> {
  await engine.putPage(slug, PERSON_PAGE, { sourceId: 'default', migrationWrite: true });
}

async function outcome<T>(fn: () => Promise<T>): Promise<{ allowed: true; value: T } | { allowed: false; message: string }> {
  try {
    return { allowed: true, value: await fn() };
  } catch (error) {
    return { allowed: false, message: String(error) };
  }
}

function failureMessage(result: { allowed: true; value: unknown } | { allowed: false; message: string }): string {
  return result.allowed ? 'unexpectedly allowed' : result.message;
}

beforeAll(async () => {
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-d1-bypass-policy-'));
  allowlistPath = join(policyDir, 'privacy-allowlist.tsv');
  previousAllowlistPath = process.env[ALLOWLIST_ENV];
  process.env[ALLOWLIST_ENV] = allowlistPath;
  writePolicy();
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

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'd1-bypass-%' OR slug LIKE 'people/d1-bypass-%' OR slug LIKE 'notes/d1-bypass-%' OR slug LIKE 'wiki/d1-bypass-%' OR slug IN ('person/lgv', 'lgv', 'wiki/chris-hooper/_author', 'chris-hooper/_author', 'chris-hooper')`);
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'lg-private'`);
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)`, [policyDir]);
});

afterAll(async () => {
  await engine.disconnect();
  if (existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
  if (previousAllowlistPath === undefined) delete process.env[ALLOWLIST_ENV];
  else process.env[ALLOWLIST_ENV] = previousAllowlistPath;
});

describe('D1 private-routing bypass paths', () => {
  test('revert_version refuses deny-listed local and remote writes, while an ordinary slug works', async () => {
    const denied = 'people/d1-bypass-denylisted-revert';
    await seedDefault(denied);
    const version = await engine.createVersion(denied, { sourceId: 'default' });
    await engine.putPage(denied, { ...PAGE, compiled_truth: 'changed body' }, { sourceId: 'default', migrationWrite: true });

    const localRed = await outcome(() => revertVersion.handler(context(false), { slug: denied, version_id: version.id }));
    expect(localRed.allowed).toBe(false);
    expect(failureMessage(localRed)).toMatch(/excluded_people_policy|private-write routing/);
    console.log(`RED revert_version local deny-listed slug: ${failureMessage(localRed)}`);

    const remoteRed = await outcome(() => revertVersion.handler(context(true), { slug: denied, version_id: version.id }));
    expect(remoteRed.allowed).toBe(false);
    expect(failureMessage(remoteRed)).toMatch(/excluded_people_policy|private source|private-write routing/);
    console.log(`RED revert_version remote deny-listed slug: ${failureMessage(remoteRed)}`);

    const ordinary = 'notes/d1-bypass-ordinary-revert';
    await seedDefault(ordinary);
    const ordinaryVersion = await engine.createVersion(ordinary, { sourceId: 'default' });
    await engine.putPage(ordinary, { ...PAGE, compiled_truth: 'ordinary changed' }, { sourceId: 'default' });
    const green = await outcome(() => revertVersion.handler(context(false), { slug: ordinary, version_id: ordinaryVersion.id }));
    expect(green.allowed).toBe(true);
    console.log(`GREEN revert_version ordinary slug: ${green.allowed ? 'allowed' : failureMessage(green)}`);
  });

  test('restore_page refuses a private collision locally and remotely, while an ordinary slug works', async () => {
    const denied = 'people/d1-bypass-denylisted-restore';
    await seedDefault(denied);
    await engine.softDeletePage(denied, { sourceId: 'default' });

    const localRed = await outcome(() => restorePage.handler(context(false), { slug: denied }));
    expect(localRed.allowed).toBe(false);
    expect(failureMessage(localRed)).toMatch(/excluded_people_policy|private-write routing/);
    console.log(`RED restore_page local deny-listed slug: ${failureMessage(localRed)}`);

    const remoteRed = await outcome(() => restorePage.handler(context(true), { slug: denied }));
    expect(remoteRed.allowed).toBe(false);
    expect(failureMessage(remoteRed)).toMatch(/excluded_people_policy|private source|private-write routing/);
    console.log(`RED restore_page remote deny-listed slug: ${failureMessage(remoteRed)}`);

    const ordinary = 'notes/d1-bypass-ordinary-restore';
    await seedDefault(ordinary);
    await engine.softDeletePage(ordinary, { sourceId: 'default' });
    const green = await outcome(() => restorePage.handler(context(false), { slug: ordinary }));
    expect(green.allowed).toBe(true);
    console.log(`GREEN restore_page ordinary slug: ${green.allowed ? 'allowed' : failureMessage(green)}`);
  });

  test('add_timeline_entry refuses a private collision locally and remotely, while an ordinary slug works', async () => {
    const denied = 'people/d1-bypass-denylisted-timeline';
    await seedDefault(denied);
    const entry = { slug: denied, date: '2026-09-15', summary: 'Denied timeline entry' };

    const localRed = await outcome(() => addTimelineEntry.handler(context(false), entry));
    expect(localRed.allowed).toBe(false);
    expect(failureMessage(localRed)).toMatch(/excluded_people_policy|private-write routing/);
    console.log(`RED add_timeline_entry local deny-listed slug: ${failureMessage(localRed)}`);

    const remoteRed = await outcome(() => addTimelineEntry.handler(context(true), entry));
    expect(remoteRed.allowed).toBe(false);
    expect(failureMessage(remoteRed)).toMatch(/excluded_people_policy|private source|private-write routing/);
    console.log(`RED add_timeline_entry remote deny-listed slug: ${failureMessage(remoteRed)}`);

    const ordinary = 'notes/d1-bypass-ordinary-timeline';
    await seedDefault(ordinary);
    const green = await outcome(() => addTimelineEntry.handler(context(false), {
      slug: ordinary, date: '2026-09-15', summary: 'Ordinary timeline entry',
    }));
    expect(green.allowed).toBe(true);
    console.log(`GREEN add_timeline_entry ordinary slug: ${green.allowed ? 'allowed' : failureMessage(green)}`);
  });

  test('restore_page and add_timeline_entry refuse a deny-listed person row outside a person prefix', async () => {
    const denied = 'wiki/d1-bypass-denylisted-x';
    await seedDefaultPerson(denied);
    await engine.softDeletePage(denied, { sourceId: 'default' });

    const restoreLocal = await outcome(() => restorePage.handler(context(false), { slug: denied }));
    console.log(`${restoreLocal.allowed ? 'RED-BEFORE-FIX' : 'GREEN'} restore_page wiki person local: ${restoreLocal.allowed ? 'ALLOWED' : failureMessage(restoreLocal)}`);
    expect(restoreLocal.allowed).toBe(false);
    expect(failureMessage(restoreLocal)).toMatch(/excluded_people_policy|private-write routing/);

    const restoreRemote = await outcome(() => restorePage.handler(context(true), { slug: denied }));
    console.log(`${restoreRemote.allowed ? 'RED-BEFORE-FIX' : 'GREEN'} restore_page wiki person remote: ${restoreRemote.allowed ? 'ALLOWED' : failureMessage(restoreRemote)}`);
    expect(restoreRemote.allowed).toBe(false);
    expect(failureMessage(restoreRemote)).toMatch(/excluded_people_policy|private source|private-write routing/);

    const timelineInput = { slug: denied, date: '2026-09-15', summary: 'Denied wiki person timeline entry' };
    const timelineLocal = await outcome(() => addTimelineEntry.handler(context(false), timelineInput));
    console.log(`${timelineLocal.allowed ? 'RED-BEFORE-FIX' : 'GREEN'} add_timeline_entry wiki person local: ${timelineLocal.allowed ? 'ALLOWED' : failureMessage(timelineLocal)}`);
    expect(timelineLocal.allowed).toBe(false);
    expect(failureMessage(timelineLocal)).toMatch(/excluded_people_policy|private-write routing/);

    const timelineRemote = await outcome(() => addTimelineEntry.handler(context(true), timelineInput));
    console.log(`${timelineRemote.allowed ? 'RED-BEFORE-FIX' : 'GREEN'} add_timeline_entry wiki person remote: ${timelineRemote.allowed ? 'ALLOWED' : failureMessage(timelineRemote)}`);
    expect(timelineRemote.allowed).toBe(false);
    expect(failureMessage(timelineRemote)).toMatch(/excluded_people_policy|private source|private-write routing/);
  });

  test('person-shaped writes refuse when the policy directory is missing', async () => {
    const denied = 'wiki/d1-bypass-arm-missing-policy';
    await seedDefaultPerson(denied);
    await engine.softDeletePage(denied, { sourceId: 'default' });
    rmSync(policyDir, { recursive: true, force: true });
    try {
      const result = await outcome(() => restorePage.handler(context(false), { slug: denied }));
      console.log(`GREEN NOT ARMED missing policy directory: ${failureMessage(result)}`);
      expect(result.allowed).toBe(false);
      expect(failureMessage(result)).toMatch(/NOT ARMED/);
    } finally {
      mkdirSync(policyDir, { recursive: true });
      writePolicy();
    }
  });

  test('all three operations refuse a non-allowlisted private collision', async () => {
    const revertSlug = 'people/d1-bypass-collision-revert';
    await seedDefault(revertSlug);
    const version = await engine.createVersion(revertSlug, { sourceId: 'default' });
    await engine.putPage(revertSlug, { ...PAGE, compiled_truth: 'collision changed' }, { sourceId: 'default', migrationWrite: true });
    await addPrivateCollision(revertSlug);
    writeFileSync(allowlistPath, '');
    const revertLocal = await outcome(() => revertVersion.handler(context(false), { slug: revertSlug, version_id: version.id }));
    const revertRemote = await outcome(() => revertVersion.handler(context(true), { slug: revertSlug, version_id: version.id }));
    expect(revertLocal.allowed).toBe(false);
    expect(failureMessage(revertLocal)).toMatch(/existing_private_page/);
    expect(revertRemote.allowed).toBe(false);
    expect(failureMessage(revertRemote)).toMatch(/private source/);
    expect((await engine.getPage(revertSlug, { sourceId: 'default' }))?.compiled_truth).toBe('collision changed');
    console.log(`RED revert_version collision local=${revertLocal.allowed} remote=${revertRemote.allowed}`);

    const restoreSlug = 'people/d1-bypass-collision-restore';
    await seedDefault(restoreSlug);
    await engine.softDeletePage(restoreSlug, { sourceId: 'default' });
    await addPrivateCollision(restoreSlug);
    const restoreLocal = await outcome(() => restorePage.handler(context(false), { slug: restoreSlug }));
    const restoreRemote = await outcome(() => restorePage.handler(context(true), { slug: restoreSlug }));
    expect(restoreLocal.allowed).toBe(false);
    expect(failureMessage(restoreLocal)).toMatch(/existing_private_page/);
    expect(restoreRemote.allowed).toBe(false);
    expect(failureMessage(restoreRemote)).toMatch(/private source/);
    expect((await engine.getPage(restoreSlug, { sourceId: 'default', includeDeleted: true }))?.deleted_at).not.toBeNull();
    console.log(`RED restore_page collision local=${restoreLocal.allowed} remote=${restoreRemote.allowed}`);

    const timelineSlug = 'people/d1-bypass-collision-timeline';
    await seedDefault(timelineSlug);
    await addPrivateCollision(timelineSlug);
    const entry = { slug: timelineSlug, date: '2026-09-15', summary: 'Collision timeline entry' };
    const timelineLocal = await outcome(() => addTimelineEntry.handler(context(false), entry));
    const timelineRemote = await outcome(() => addTimelineEntry.handler(context(true), entry));
    expect(timelineLocal.allowed).toBe(false);
    expect(failureMessage(timelineLocal)).toMatch(/existing_private_page/);
    expect(timelineRemote.allowed).toBe(false);
    expect(failureMessage(timelineRemote)).toMatch(/private source/);
    expect((await engine.getPage(timelineSlug, { sourceId: 'default' }))?.timeline).toBe('');
    expect(await engine.executeRaw('SELECT 1 FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = $1', [timelineSlug])).toHaveLength(0);
    console.log(`RED add_timeline_entry collision local=${timelineLocal.allowed} remote=${timelineRemote.allowed}`);
  });

  test('revert_version follows put_page collision allowlist behavior', async () => {
    for (const { slug, privateSlug } of ALLOWLISTED_COLLISIONS) {
      await seedDefault(slug);
      const version = await engine.createVersion(slug, { sourceId: 'default' });
      await engine.putPage(slug, { ...PAGE, compiled_truth: 'changed body' }, { sourceId: 'default', migrationWrite: true });
      await addPrivateCollision(privateSlug);
      writeFileSync(allowlistPath, `collision|${slug}\n`);

      const localGreen = await outcome(() => revertVersion.handler(context(false), { slug, version_id: version.id }));
      expect(localGreen.allowed).toBe(true);
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('original body');
      const remoteRed = await outcome(() => revertVersion.handler(context(true), { slug, version_id: version.id }));
      expect(remoteRed.allowed).toBe(false);
      console.log(`ALLOWLIST revert_version ${slug} local=${localGreen.allowed} remote=${remoteRed.allowed}`);
    }
  });

  test('restore_page follows put_page collision allowlist behavior', async () => {
    for (const { slug, privateSlug } of ALLOWLISTED_COLLISIONS) {
      await seedDefault(slug);
      await engine.softDeletePage(slug, { sourceId: 'default' });
      await addPrivateCollision(privateSlug);
      writeFileSync(allowlistPath, `collision|${slug}\n`);

      const localGreen = await outcome(() => restorePage.handler(context(false), { slug }));
      expect(localGreen.allowed).toBe(true);
      const remoteRed = await outcome(() => restorePage.handler(context(true), { slug }));
      expect(remoteRed.allowed).toBe(false);
      console.log(`ALLOWLIST restore_page ${slug} local=${localGreen.allowed} remote=${remoteRed.allowed}`);
    }
  });

  test('add_timeline_entry follows put_page collision allowlist behavior', async () => {
    for (const { slug, privateSlug } of ALLOWLISTED_COLLISIONS) {
      await seedDefault(slug);
      await addPrivateCollision(privateSlug);
      writeFileSync(allowlistPath, `collision|${slug}\n`);
      const entry = { slug, date: '2026-09-15', summary: 'Allowlisted timeline entry' };

      const localGreen = await outcome(() => addTimelineEntry.handler(context(false), entry));
      expect(localGreen.allowed).toBe(true);
      const remoteRed = await outcome(() => addTimelineEntry.handler(context(true), entry));
      expect(remoteRed.allowed).toBe(false);
      console.log(`ALLOWLIST add_timeline_entry ${slug} local=${localGreen.allowed} remote=${remoteRed.allowed}`);
    }
  });
});
