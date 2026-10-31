/**
 * Regression: routed put_page removes the default copy through the persistence
 * coordinator. A managed brain refuses a raw engine soft delete, so the world
 * copy used to stay live after the private write committed. An unmanaged brain
 * still soft-deletes that copy. PGLite in-process only.
 */
import { afterAll, beforeAll, describe, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { ROUTED_DEFAULT_TOMBSTONE_KEY } from '../src/core/persistence/page-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const putPage = operationsByName.put_page;
const deletePage = operationsByName.delete_page;
if (!putPage || !deletePage) throw new Error('put_page or delete_page operation missing');

const SLUG = 'people/routed-softdel-probe';
const PRIVATE_KEY = 'routed-softdel-probe';
const REMOTE_SLUG = 'people/routed-softdel-remote';
const REMOTE_KEY = 'routed-softdel-remote';
const OLD_DEFAULT = 'OLD DEFAULT BODY 1031';
const OLD_PRIVATE = 'OLD PRIVATE BODY 1031';
const NEW_MARK = 'NEW PRIVATE BODY 1031';
const CONTENT = `---\ntype: person\ntitle: Routed Softdel Probe\n---\n\n${NEW_MARK}\n`;
const DENY = '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated-family-entry` | Unrelated Family Entry |\n';
const DISPATCH_SLUG = 'notes/routed-softdel-dispatch';
const STRIP_SLUG = 'notes/routed-softdel-strip';
const GUARD_SLUG = 'notes/routed-softdel-guard';
const NOTE_BODY = 'NOTE BODY 1031';

const root = mkdtempSync(join(tmpdir(), 'gbrain-d1-routed-softdel-'));
const home = join(root, 'home');
const privateDir = join(root, 'private');
mkdirSync(home);
mkdirSync(privateDir);
writeFileSync(join(privateDir, '_excluded-people.md'), DENY);
writeFileSync(join(privateDir, '_brain-filing-rules.md'), '# filing rules\n');

const ENV: Record<string, string | undefined> = {
  GBRAIN_HOME: home,
  GBRAIN_PRIVACY_ALLOWLIST_PATH: join(root, 'missing-allowlist.tsv'),
  OPENAI_API_KEY: undefined,
  VOYAGE_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
};

function test(name: string, fn: () => unknown, timeout?: number) {
  return bunTest(name, () => withEnv(ENV, () => fn()), timeout);
}

let engine: PGLiteEngine;

function context(remote = false) {
  return {
    engine,
    config: { engine: 'pglite' as const, embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote,
    sourceId: 'default',
  };
}

function clearRoutedFile(): void {
  try { unlinkSync(join(privateDir, 'people', 'routed-softdel-probe.md')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function pageBody(compiledTruth: string) {
  return {
    type: 'person',
    title: 'Routed Softdel Probe',
    compiled_truth: compiledTruth,
    timeline: '',
    frontmatter: {},
  };
}

function noteBody(compiledTruth: string) {
  return {
    type: 'note',
    title: 'Routed Softdel Note',
    compiled_truth: compiledTruth,
    timeline: '',
    frontmatter: {},
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && (error as { code?: unknown }).code != null
      ? String((error as { code?: unknown }).code)
      : '';
    return code ? `${code}: ${error.message}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

interface Row {
  source_id: string;
  compiled_truth: string;
  deleted: boolean;
}

async function versionCount(slug: string, sourceId = 'default'): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM page_versions v
     JOIN pages p ON p.id = v.page_id
     WHERE p.slug = $1 AND p.source_id = $2`,
    [slug, sourceId],
  );
  return Number(row?.n ?? 0);
}

/** A note on the default source. Its delete takes the normal path: createVersion, then soft delete. */
async function seedNote(slug: string): Promise<string> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [slug]);
  await engine.putPage(slug, noteBody(NOTE_BODY), { sourceId: 'default', migrationWrite: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))?.revision;
  if (typeof revision !== 'string') throw new Error(`no revision for ${slug}`);
  return revision;
}

function toolEnvelope(result: { content: { text: string }[] }): { error?: string; suggestion?: string; message?: string } {
  return JSON.parse(result.content[0]?.text ?? '{}') as { error?: string; suggestion?: string; message?: string };
}

async function rowsFor(slug: string): Promise<Row[]> {
  const rows = await engine.executeRaw<{ source_id: string; compiled_truth: string; deleted: boolean | string }>(
    `SELECT source_id, compiled_truth, (deleted_at IS NOT NULL) AS deleted
     FROM pages WHERE slug = $1 ORDER BY source_id`,
    [slug],
  );
  return rows.map(row => ({
    source_id: row.source_id,
    compiled_truth: row.compiled_truth,
    deleted: row.deleted === true || row.deleted === 't' || row.deleted === 'true',
  }));
}

async function measure(label: 'A' | 'B', managed: boolean) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  await engine.executeRaw('DELETE FROM pages WHERE slug IN ($1, $2)', [SLUG, PRIVATE_KEY]);
  clearRoutedFile();
  await engine.putPage(PRIVATE_KEY, pageBody(OLD_PRIVATE), { sourceId: 'lg-private' });
  // The default row is the pre-existing world copy. migrationWrite is the
  // fixture bypass the collision tests use so the armed guard does not
  // refuse the seed itself.
  await engine.putPage(SLUG, pageBody(OLD_DEFAULT), { sourceId: 'default', migrationWrite: true });
  clearRoutedFile();
  await engine.executeRaw('UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1', [managed]);
  const [flag] = await engine.executeRaw<{ enabled: boolean | string }>('SELECT enabled FROM persistence_brain WHERE singleton = 1');
  const enabled = flag.enabled === true || flag.enabled === 't' || flag.enabled === 'true';

  let outcome: 'ok' | 'throw' = 'ok';
  let error = '';
  try {
    await putPage.handler(context(), { slug: SLUG, content: CONTENT });
  } catch (caught) {
    outcome = 'throw';
    error = errorText(caught);
  }

  const slugRows = await rowsFor(SLUG);
  const keyRows = await rowsFor(PRIVATE_KEY);
  const liveDefault = await engine.getPage(SLUG, { sourceId: 'default' });
  const livePrivate = await engine.getPage(SLUG, { sourceId: 'lg-private' });
  const liveDefaultDeleted = await engine.getPage(SLUG, { sourceId: 'default', includeDeleted: true });
  const privateRow = slugRows.find(row => row.source_id === 'lg-private') ?? null;
  const defaultRow = slugRows.find(row => row.source_id === 'default') ?? null;
  const line = [
    `RECEIPT case=${label}`,
    `managed=${enabled}`,
    `outcome=${outcome}`,
    `error=${JSON.stringify(error)}`,
    `private_present=${privateRow ? 'yes' : 'no'}`,
    `private_deleted=${privateRow ? String(privateRow.deleted) : 'n/a'}`,
    `private_truth=${JSON.stringify(privateRow?.compiled_truth ?? null)}`,
    `private_live_read=${JSON.stringify(livePrivate?.compiled_truth ?? null)}`,
    `default_present=${defaultRow ? 'yes' : 'no'}`,
    `default_deleted=${defaultRow ? String(defaultRow.deleted) : 'n/a'}`,
    `default_truth=${JSON.stringify(defaultRow?.compiled_truth ?? null)}`,
    `default_live_read=${JSON.stringify(liveDefault?.compiled_truth ?? null)}`,
    `default_include_deleted_truth=${JSON.stringify(liveDefaultDeleted?.compiled_truth ?? null)}`,
    `candidate_truth=${JSON.stringify(keyRows.find(row => row.source_id === 'lg-private')?.compiled_truth ?? null)}`,
    `candidate_deleted=${String(keyRows.find(row => row.source_id === 'lg-private')?.deleted ?? 'n/a')}`,
  ].join(' ');
  console.log(line);
  return { line, outcome, error, enabled, privateRow, defaultRow, liveDefault, livePrivate };
}

beforeAll(async () => {
  await withEnv(ENV, async () => {
    resetGateway();
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
    await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
    await engine.setConfig('sync.write_through', 'true');
    await engine.setConfig('embedding_disabled', 'true');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)`,
      [privateDir],
    );
    await claimWorktree(engine, 'lg-private', privateDir);
  });
}, 180_000);

afterAll(async () => {
  await withEnv(ENV, async () => {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
    await engine.disconnect();
    resetGateway();
  });
}, 60_000);

describe('routed put_page soft-deletes the default copy through the coordinator', () => {
  test('case B unmanaged brain', async () => {
    const observed = await measure('B', false);
    expect(observed.enabled).toBe(false);
    expect(observed.outcome).toBe('ok');
    expect(observed.error).toBe('');
    expect(observed.privateRow).toEqual({ source_id: 'lg-private', compiled_truth: NEW_MARK, deleted: false });
    expect(observed.livePrivate?.compiled_truth).toBe(NEW_MARK);
    expect(observed.defaultRow).toEqual({ source_id: 'default', compiled_truth: OLD_DEFAULT, deleted: true });
    expect(observed.liveDefault).toBeNull();
  }, 180_000);

  test('case A managed brain', async () => {
    const observed = await measure('A', true);
    expect(observed.enabled).toBe(true);
    expect(observed.outcome).toBe('ok');
    expect(observed.error).toBe('');
    expect(observed.privateRow).toEqual({ source_id: 'lg-private', compiled_truth: NEW_MARK, deleted: false });
    expect(observed.livePrivate?.compiled_truth).toBe(NEW_MARK);
    expect(observed.defaultRow).toEqual({ source_id: 'default', compiled_truth: OLD_DEFAULT, deleted: true });
    expect(observed.liveDefault).toBeNull();
  }, 180_000);

  test('case C remote delete of a routed-away slug stays refused', async () => {
    expect(deletePage.params).not.toHaveProperty(ROUTED_DEFAULT_TOMBSTONE_KEY);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
    await engine.executeRaw('DELETE FROM pages WHERE slug IN ($1, $2)', [REMOTE_SLUG, REMOTE_KEY]);
    await engine.putPage(REMOTE_KEY, pageBody(OLD_PRIVATE), { sourceId: 'lg-private' });
    await engine.putPage(REMOTE_SLUG, pageBody(OLD_DEFAULT), { sourceId: 'default', migrationWrite: true });
    await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
    const revision = (await engine.readPageSnapshot(REMOTE_SLUG, { sourceId: 'default', includeDeleted: true }))?.revision;
    expect(typeof revision).toBe('string');

    const errors: string[] = [];
    for (const extra of [{}, { [ROUTED_DEFAULT_TOMBSTONE_KEY]: true }]) {
      try {
        await deletePage.handler(context(true), { slug: REMOTE_SLUG, expected_revision: revision, ...extra });
        errors.push('ok');
      } catch (caught) {
        errors.push(errorText(caught));
      }
    }
    const slugRows = await rowsFor(REMOTE_SLUG);
    const defaultRow = slugRows.find(row => row.source_id === 'default') ?? null;
    const liveDefault = await engine.getPage(REMOTE_SLUG, { sourceId: 'default' });
    console.log([
      'RECEIPT case=C',
      `plain=${JSON.stringify(errors[0] ?? '')}`,
      `with_key=${JSON.stringify(errors[1] ?? '')}`,
      `default_deleted=${defaultRow ? String(defaultRow.deleted) : 'n/a'}`,
      `default_truth=${JSON.stringify(defaultRow?.compiled_truth ?? null)}`,
      `default_live_read=${JSON.stringify(liveDefault?.compiled_truth ?? null)}`,
    ].join(' '));
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]).toMatch(/^storage_error: Publication failed on an unexpected owner exception\./);
    expect(defaultRow).toEqual({ source_id: 'default', compiled_truth: OLD_DEFAULT, deleted: false });
    expect(liveDefault?.compiled_truth).toBe(OLD_DEFAULT);
  }, 180_000);

  test('case C1 remote dispatch rejects the tombstone key as an unknown parameter', async () => {
    const revision = await seedNote(DISPATCH_SLUG);
    const versionsBefore = await versionCount(DISPATCH_SLUG);
    const result = await dispatchToolCall(engine, 'delete_page', {
      slug: DISPATCH_SLUG,
      expected_revision: revision,
      [ROUTED_DEFAULT_TOMBSTONE_KEY]: true,
    }, { remote: true, transport: 'stdio', sourceId: 'default', config: context().config, logger: context().logger });
    const envelope = toolEnvelope(result);
    const slugRows = await rowsFor(DISPATCH_SLUG);
    const defaultRow = slugRows.find(row => row.source_id === 'default') ?? null;
    const versionsAfter = await versionCount(DISPATCH_SLUG);
    console.log([
      'RECEIPT case=C1',
      `is_error=${String(result.isError === true)}`,
      `error=${JSON.stringify(envelope.error ?? '')}`,
      `versions_before=${versionsBefore}`,
      `versions_after=${versionsAfter}`,
      `default_deleted=${defaultRow ? String(defaultRow.deleted) : 'n/a'}`,
      `default_truth=${JSON.stringify(defaultRow?.compiled_truth ?? null)}`,
    ].join(' '));
    expect(result.isError).toBe(true);
    expect(envelope.error).toBe('invalid_params');
    expect(envelope.suggestion ?? '').toContain(ROUTED_DEFAULT_TOMBSTONE_KEY);
    expect(versionsAfter).toBe(versionsBefore);
    expect(defaultRow).toEqual({ source_id: 'default', compiled_truth: NOTE_BODY, deleted: false });
  }, 180_000);

  test('case C2 local handler strips the tombstone key and still records a version', async () => {
    const revision = await seedNote(STRIP_SLUG);
    const versionsBefore = await versionCount(STRIP_SLUG);
    await deletePage.handler(context(false), {
      slug: STRIP_SLUG,
      expected_revision: revision,
      [ROUTED_DEFAULT_TOMBSTONE_KEY]: true,
    });
    const versionsAfter = await versionCount(STRIP_SLUG);
    const slugRows = await rowsFor(STRIP_SLUG);
    const defaultRow = slugRows.find(row => row.source_id === 'default') ?? null;
    const liveDefault = await engine.getPage(STRIP_SLUG, { sourceId: 'default' });
    console.log([
      'RECEIPT case=C2',
      `versions_before=${versionsBefore}`,
      `versions_after=${versionsAfter}`,
      `default_deleted=${defaultRow ? String(defaultRow.deleted) : 'n/a'}`,
      `live=${JSON.stringify(liveDefault?.compiled_truth ?? null)}`,
    ].join(' '));
    expect(versionsAfter).toBe(versionsBefore + 1);
    expect(defaultRow).toEqual({ source_id: 'default', compiled_truth: NOTE_BODY, deleted: true });
    expect(liveDefault).toBeNull();
  }, 180_000);

  test('case C3 remote authority with the key still records a version', async () => {
    const revision = await seedNote(GUARD_SLUG);
    const versionsBefore = await versionCount(GUARD_SLUG);
    await submitPageMutation(context(true), {
      operation: 'delete_page',
      params: {
        slug: GUARD_SLUG,
        expected_revision: revision,
        [ROUTED_DEFAULT_TOMBSTONE_KEY]: true,
      },
    });
    const versionsAfter = await versionCount(GUARD_SLUG);
    const slugRows = await rowsFor(GUARD_SLUG);
    const defaultRow = slugRows.find(row => row.source_id === 'default') ?? null;
    const liveDefault = await engine.getPage(GUARD_SLUG, { sourceId: 'default' });
    console.log([
      'RECEIPT case=C3',
      `versions_before=${versionsBefore}`,
      `versions_after=${versionsAfter}`,
      `default_deleted=${defaultRow ? String(defaultRow.deleted) : 'n/a'}`,
      `live=${JSON.stringify(liveDefault?.compiled_truth ?? null)}`,
    ].join(' '));
    expect(versionsAfter).toBe(versionsBefore + 1);
    expect(defaultRow).toEqual({ source_id: 'default', compiled_truth: NOTE_BODY, deleted: true });
    expect(liveDefault).toBeNull();
  }, 180_000);
});
