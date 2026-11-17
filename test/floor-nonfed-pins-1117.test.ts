/**
 * Fork source floor on a NON-federated source: the three fail-closed products
 * the federated fixtures no longer observe (FINDING P2-1, carried from fork
 * production 6690b2ee):
 *
 *   (a) `gbrain bootstrap verify` reports a magic_moment failure because
 *       src/core/bootstrap/verify.ts reads visibility='world' only, while the
 *       fence fact written into a source without {"federated":true} is floored
 *       private.
 *   (b) `gbrain mcp verify`'s memory-writer can write its fixture fact but not
 *       read it back or forget it: the remote remember is floored private, so
 *       the remote recall misses it and the remote forget answers not_found.
 *       The fixture fact stays active after cleanup.
 *   (c) remote hot memory is empty for a non-federated member source: the fact
 *       is floored private and the remote world-only read finds nothing, so no
 *       `_meta.brain_hot_memory` block is attached.
 *
 * Every source here is inserted WITHOUT {"federated":true}. In-test PGLite
 * only; no external database URL is read or set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource } from '../src/core/sources-ops.ts';
import {
  verifyWorkspace,
  VERIFY_MAGIC_TOKEN,
} from '../src/core/bootstrap/verify.ts';
import { writeManifest } from '../src/core/bootstrap/format.ts';
import type { CapabilityReport } from '../src/core/capability.ts';

import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { verifyHarnessConnection, type VerificationPeer } from '../src/core/harness/verify.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

import { mintLegacyToken } from '../src/core/token-mint.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { callTool, startServeHttp, type LiveServeHttp } from './helpers/live-mcp-servers.ts';
import { asOwner } from './helpers/owner-tier.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

// (a) bootstrap verify magic_moment on a non-federated workspace source

describe('(a) bootstrap verify magic_moment on a non-federated source', () => {
  let engine: PGLiteEngine;
  let tmpParent: string;
  let home: string;
  let ws: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    tmpParent = mkdtempSync(join(tmpdir(), 'gb-floor-nonfed-verify-'));
    home = join(tmpParent, '.gbrain');
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    ws = mkdtempSync(join(tmpdir(), 'gb-floor-nonfed-ws-'));
    prevHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpParent;

    writeManifest(ws, {
      format_version: 1,
      initialized: true,
      agent_name: 'Non-federated Verify Test Agent',
      created_by: 'test',
      created_at: new Date().toISOString(),
      source_id: 'workspace',
    });
    mkdirSync(join(ws, 'brain'), { recursive: true });

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // The workspace source exists and owns brain/, but carries NO federated:true.
    await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true, federated: false });
  }, 240_000);

  afterAll(async () => {
    try {
      await engine?.disconnect();
    } catch {
      /* noop */
    }
    if (prevHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = prevHome;
    rmSync(tmpParent, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test('the fence-written probe fact is floored private, so magic_moment reports the fail-closed failure', async () => {
    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
      skipHooksSmoke: true,
      sweepBudgetMs: 20_000,
    });

    // The roundtrip family ran (so magic_moment was actually reached),
    const roundtrip = res.checks.filter((c) => c.id === 'roundtrip');
    expect(roundtrip.length).toBeGreaterThan(0);
    expect(roundtrip.every((c) => c.ok || c.warn === true)).toBe(true);

    // and the world-only read-back sees nothing: the fact is private on this source.
    const magic = res.checks.find((c) => c.id === 'magic_moment');
    expect(magic).toBeDefined();
    expect(magic!.ok).toBe(false);
    expect(magic!.detail).toContain('never reached the facts index');
    expect(res.ok).toBe(false);

    const worldRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM facts WHERE source_id = $1 AND visibility = 'world' AND fact LIKE $2`,
      ['workspace', `%${VERIFY_MAGIC_TOKEN}%`],
    );
    expect(worldRows).toEqual([]);
  }, 240_000);
});

// (b) mcp verify memory-writer fixture on a non-federated source

describe('(b) mcp verify memory-writer cannot forget its floored-private fixture', () => {
  let engine: PGLiteEngine;
  const sourceId = 'nonfed-mcp-verify-source';
  const credentials: HarnessCredentials = {
    version: 1,
    client_id: 'gbrain_cl_floor_nonfed_1117',
    mcp_url: 'https://brain.example.com/mcp',
    issuer_url: 'https://brain.example.com',
    access_token: 'fixture-token',
    source_id: sourceId,
    profile: 'memory-writer',
  };
  const remoteCtx = {
    remote: true,
    sourceId,
    config: { engine: 'pglite' },
    dryRun: false,
    auth: { clientId: credentials.client_id, scopes: ['read', 'write'], sourceId },
    logger: { info() {}, warn() {}, error() {} },
  };

  beforeAll(async () => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    // No {"federated":true}: the fork source floor makes remote writes private.
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{}'::jsonb)`, [sourceId]);
    await registerLocalWriter(engine, 'cli');
    await registerLocalWriter(engine, 'stdio');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }, 60_000);

  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    resetGateway();
  });

  test('write passes, but the remote read-back and forget fail and the private fixture stays active', async () => {
    const peer: VerificationPeer = {
      connect: async () => {},
      close: async () => {},
      readCapabilities: async () => ({
        transport: 'oauth',
        client_id: credentials.client_id,
        scopes: ['read', 'write'],
        source_id: sourceId,
      }),
      call: async (name, params) => operationsByName[name]!.handler({ ...remoteCtx, engine } as unknown as OperationContext, params),
    };

    const report = await verifyHarnessConnection(credentials, { peer, timeoutMs: 30_000 });

    // The write itself commits through the op layer, floored to private,
    expect(report.stages.find((s) => s.name === 'write')?.status).toBe('passed');
    // so the remote world-only read-back cannot see it,
    expect(report.stages.find((s) => s.name === 'write_readback')).toMatchObject({ status: 'failed' });
    // and the remote forget answers not_found rather than withdrawing it.
    expect(report.stages.find((s) => s.name === 'cleanup')).toMatchObject({ status: 'failed' });

    // The fixture fact is an active, private row left behind by cleanup.
    const active = await engine.executeRaw<{ id: number; visibility: string }>(
      'SELECT id, visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL',
      [sourceId, report.fixture],
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.visibility).toBe('private');
  }, 60_000);
});

// (c) remote hot memory on a non-federated member source

describe('(c) remote hot memory for a non-federated member source', () => {
  let engine: PGLiteEngine;
  let app: LiveServeHttp;
  let token: string;
  const MEMBER_SOURCE = 'nonfed-hot-memory-member';
  const FACT = 'alice-example keeps a written decision log';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    // The member source exists WITHOUT {"federated":true}.
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [MEMBER_SOURCE]);
    await asOwner(engine, (tx) =>
      tx.insertFact(
        { fact: FACT, kind: 'preference', entity_slug: 'people/alice-example', visibility: 'world', source: 'test' },
        { source_id: MEMBER_SOURCE },
      ),
    );
    token = (await mintLegacyToken(engine, {
      name: 'floor-nonfed-hot-member',
      scopes: ['read'],
      takesHolders: ['world'],
      sourceGrant: [MEMBER_SOURCE],
    })).token;
    app = await startServeHttp(engine);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await engine?.disconnect();
  });

  test('a world-only member token gets no hot-memory block because the fact is floored private', async () => {
    __resetHotMemoryCacheForTests();
    const r = await callTool(app.base, token, 'search', { query: 'decision log' });
    expect(r.isError).toBeFalsy();
    expect((r._meta as { brain_hot_memory?: unknown } | undefined)?.brain_hot_memory).toBeUndefined();

    // The stored fact is active but private, which is why the remote read finds none.
    const rows = await engine.executeRaw<{ visibility: string }>(
      'SELECT visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL',
      [MEMBER_SOURCE, FACT],
    );
    expect(rows).toEqual([{ visibility: 'private' }]);

    // The hook is not simply disabled: with the source federated the same fixture
    // would be visible. Prove the helper itself returns a block for a world row.
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source, kind, entity_slug, visibility)
       VALUES ($1, $2, 'test', 'preference', 'people/alice-example', 'world')`,
      [MEMBER_SOURCE, 'alice-example prefers async standups'],
    );
    __resetHotMemoryCacheForTests();
    const withWorld = await callTool(app.base, token, 'search', { query: 'standups' });
    expect(withWorld.isError).toBeFalsy();
    const block = (withWorld._meta as { brain_hot_memory?: { source_id: string; facts: unknown[] } })?.brain_hot_memory;
    expect(block?.source_id).toBe(MEMBER_SOURCE);
    expect(JSON.stringify(block?.facts)).toContain('alice-example prefers async standups');
  }, 60_000);
});
