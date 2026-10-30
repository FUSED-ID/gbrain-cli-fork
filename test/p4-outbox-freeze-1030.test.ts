import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' as const, embedding_disabled: true };
const body = 'A useful substantive record of this project and its current status. '.repeat(4);
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function fixture(run: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-p4-outbox-'));
  try { await withEnv({ GBRAIN_HOME: home }, async () => { await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_SCHEMA_VERSION)); await registerLocalWriter(engine, 'cli'); await run(); }); }
  finally { rmSync(home, { force: true, recursive: true }); }
}

async function source(id: string, sourceConfig: Record<string, unknown>) {
  await engine.executeRaw(
    'INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, archived=false',
    [id, JSON.stringify(sourceConfig)],
  );
}

/** A managed put_page on `sourceId`, published; returns the publication's outcome row. */
async function publishPage(sourceId: string, slug: string, visibility?: 'private') {
  const content = `---\ntype: note\ntitle: ${slug}\n${visibility ? `visibility: ${visibility}\n` : ''}---\n\n${body}`;
  const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, src.incarnation, slug);
  const current = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: src.incarnation, slug, pageId: current?.page.id ?? null, requestId: randomUUID(),
    callerIntent: { content }, intent: { content } });
  const row = (await claimNextWrite(engine, localHostId()))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, config));
}

/** The visibility frozen into the queued facts-backstop effect row. */
async function frozenVisibility(requestId: string): Promise<string | undefined> {
  const [effect] = await engine.executeRaw<{ data: { visibility?: string } }>(
    "SELECT data FROM persistence_effects WHERE request_id=$1::uuid AND kind='facts-backstop'", [requestId]);
  return effect?.data.visibility;
}

test('(a) world brain default on a non-federated source freezes private at enqueue', () => fixture(async () => {
  await source('p4-outbox-unfed', {});
  await engine.setConfig('facts.default_visibility', 'world');
  const row = await publishPage('p4-outbox-unfed', 'notes/unfed');
  expect(row.outcome?.facts_backstop).toEqual({ queued: true });
  expect(await frozenVisibility(row.id)).toBe('private');
}));

test('(b) world default on a federated source with a private page freezes private', () => fixture(async () => {
  await source('p4-outbox-fed', { federated: true, facts_visibility: 'world' });
  await engine.setConfig('facts.default_visibility', 'world');
  const row = await publishPage('p4-outbox-fed', 'notes/fed-private', 'private');
  expect(row.outcome?.facts_backstop).toEqual({ queued: true });
  expect(await frozenVisibility(row.id)).toBe('private');
}));

test('(c) control: world default on a federated source with a public page freezes world', () => fixture(async () => {
  await source('p4-outbox-fed-public', { federated: true, facts_visibility: 'world' });
  await engine.setConfig('facts.default_visibility', 'world');
  const row = await publishPage('p4-outbox-fed-public', 'notes/fed-public');
  expect(row.outcome?.facts_backstop).toEqual({ queued: true });
  expect(await frozenVisibility(row.id)).toBe('world');
}));
