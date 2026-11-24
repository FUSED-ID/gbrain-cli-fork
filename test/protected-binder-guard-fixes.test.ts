/**
 * Fable NO-GO fixes on the Binder guard (2026-11-24).
 * MUST 1: GBRAIN_PROTECTED_SLUG_PATTERNS only ADDS patterns; GBRAIN_PROTECTED_BINDER_GUARD=off is the only off switch;
 *         the worker logs the active patterns. SHOULD 2: the maintenance apply side settles skipped. SHOULD 3: the
 *         backstop's DB-only legacy bucket writes no row on a Binder entity. SHOULD 5: a named per-request operator
 *         override admits one maintenance write. LOW 6: <source>:<slug>, write-single, the affectedSlugs branch,
 *         and embed-backfill still embedding a Binder page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { makeEmbedBackfillHandler } from '../src/core/minions/handlers/embed-backfill.ts';
import { discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { maintenancePreflight, prepareMaintenanceMutation, publishMaintenancePage } from '../src/core/persistence/prepared-maintenance.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

const SKIP = 'protected_binder_page';
const GUARD = 'GBRAIN_PROTECTED_BINDER_GUARD';
const PATTERNS = 'GBRAIN_PROTECTED_SLUG_PATTERNS';
const BINDER = 'docs/binder-gbrain-conops-doc-family-2026-11-24-t3';
const PLAIN = 'notes/plain-example';
const BODY = `Alice Example agreed to ship the beta. ${'A substantive project record with names, dates and decisions about the launch plan. '.repeat(10)}`;
const mod = () => import('../src/core/persistence/protected-binder-pages.ts');

describe('MUST 1: patterns add, one explicit off switch, startup log', () => {
  test('a configured pattern never replaces the default (Fable measured both of these disabling it)', async () => {
    const { isProtectedBinderPage } = await mod();
    for (const value of ['binder-gbrain-conops-doc-family', 'binder', 'notes/*', ' ', 'no-such-page-*']) {
      await withEnv({ [PATTERNS]: value, [GUARD]: undefined }, async () => { expect(isProtectedBinderPage(BINDER), value).toBe(true); });
    }
    await withEnv({ [PATTERNS]: 'notes/*', [GUARD]: undefined }, async () => { expect(isProtectedBinderPage(PLAIN)).toBe(true); });
  });
  test('only GBRAIN_PROTECTED_BINDER_GUARD=off turns the guard off', async () => {
    const { isProtectedBinderPage } = await mod();
    for (const value of ['', '0', 'no', 'false', 'disabled', 'of']) {
      await withEnv({ [GUARD]: value }, async () => { expect(isProtectedBinderPage(BINDER), value).toBe(true); });
    }
    for (const value of ['off', 'OFF', ' Off ']) {
      await withEnv({ [GUARD]: value }, async () => { expect(isProtectedBinderPage(BINDER), value).toBe(false); });
    }
  });
  test('the worker start line names the active patterns, or says OFF', async () => {
    const { logProtectedBinderGuard } = await mod();
    const lines: string[] = [];
    const on = await withEnv({ [GUARD]: undefined, [PATTERNS]: 'notes/*' }, async () => logProtectedBinderGuard(l => lines.push(l)));
    expect(on).toContain('binder-gbrain-conops-doc-family-*');
    expect(on).toContain('notes/*');
    const off = await withEnv({ [GUARD]: 'off' }, async () => logProtectedBinderGuard(l => lines.push(l)));
    expect(off).toContain('OFF');
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});

describe('LOW 6: the <source>:<slug> form', () => {
  test('predicate and SQL patterns both match a source-qualified Binder slug', async () => {
    const { isProtectedBinderPage, protectedSlugLikePatterns } = await mod();
    await withEnv({ [GUARD]: undefined, [PATTERNS]: undefined }, async () => {
      expect(isProtectedBinderPage(`lg-private:${BINDER}`)).toBe(true);
      expect(isProtectedBinderPage('default:binder-gbrain-conops-doc-family-2026-11-23')).toBe(true);
      expect(isProtectedBinderPage(`lg-private:${PLAIN}`)).toBe(false);
      const engine = new PGLiteEngine(); await engine.connect({});
      try {
        const [row] = await engine.executeRaw<{ a: boolean; b: boolean; c: boolean }>(
          'SELECT $2 ILIKE ANY($1::text[]) AS a, $3 ILIKE ANY($1::text[]) AS b, $4 ILIKE ANY($1::text[]) AS c',
          [protectedSlugLikePatterns(), `lg-private:${BINDER}`, 'default:binder-gbrain-conops-doc-family-x', `lg-private:${PLAIN}`]);
        expect(row).toEqual({ a: true, b: true, c: false });
      } finally { await engine.disconnect(); }
    });
  });
});

describe('unmanaged brain writers', () => {
  let engine: PGLiteEngine;
  let home: string;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); home = mkdtempSync(join(tmpdir(), 'gbrain-bg3-')); }, 60_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
  beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_VERSION)); });
  afterEach(() => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); });
  const put = (slug: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: BODY, timeline: '', frontmatter: {} } as never);
  const reply = (text: string, model = 'anthropic:claude-sonnet-4-6'): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', model, providerId: 'anthropic',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult);
  const ctx = (name: string, id: number, data: Record<string, unknown>) => {
    const signal = new AbortController().signal;
    return { id, name, data, attempts_made: 0, signal, deadlineAtMs: null, shutdownSignal: signal, updateProgress: async () => {}, updateTokens: async () => {},
      log: async () => {}, isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
  };
  const vec = (n: number) => { const v = new Array<number>(n).fill(0); v[0] = 1; return v; };
  const factsOn = (slug: string) => engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE entity_slug=$1", [slug]).then(r => r[0].n);

  test('LOW 6: the affectedSlugs ($6) discovery branch leaves a Binder page out; off keeps it', async () => {
    await put(BINDER); await put(PLAIN);
    const on = await withEnv({ [GUARD]: undefined }, () => discoverExtractablePages(engine, 'default', [BINDER, PLAIN]));
    expect(on.map(p => p.slug)).toEqual([PLAIN]);
    const off = await withEnv({ [GUARD]: 'off' }, () => discoverExtractablePages(engine, 'default', [BINDER, PLAIN]));
    expect(off.map(p => p.slug).sort()).toEqual([BINDER, PLAIN].sort());
  }, 60_000);

  test('SHOULD 3: the backstop DB-only legacy bucket writes no fact on a Binder entity; off writes it', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
      env: { ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' } } as never);
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
    __setChatTransportForTests(async (opts: ChatOpts) => reply(JSON.stringify({ facts: [
      { fact: 'The Binder records the doc family index', kind: 'fact', entity: BINDER, confidence: 1, notability: 'high' }] }), opts.model));
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => vec(1536)) })) as never);
    const run = async () => {
      await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_VERSION));
      await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
      await put(BINDER); await put(PLAIN);
      const job = await new MinionQueue(engine).add('facts-absorb', { slug: PLAIN, sourceId: 'default', source: 'mcp:put_page', notabilityFilter: 'all', visibility: 'private' });
      await withEnv({ GBRAIN_HOME: home }, () => makeFactsAbsorbHandler(engine)(ctx('facts-absorb', job.id, job.data as Record<string, unknown>)));
      return factsOn(BINDER);
    };
    expect(await withEnv({ [GUARD]: undefined }, run)).toBe(0);
    expect(await withEnv({ [GUARD]: 'off' }, run)).toBeGreaterThan(0);
  }, 60_000);

  test('LOW 6: writeSingleFact refuses a Binder entity with code protected_binder_page; off writes it', async () => {
    await put(BINDER);
    const write = () => writeSingleFact(engine, 'default', { fact: 'The Binder indexes the doc family', provenance: 'test:bg3', entity: BINDER });
    const err = await withEnv({ [GUARD]: undefined }, () => write().then(() => null, (e: { code?: string }) => e));
    expect(err).toMatchObject({ code: SKIP });
    expect(await factsOn(BINDER)).toBe(0);
    const ok = await withEnv({ [GUARD]: 'off' }, () => write());
    expect(ok.id).toBeGreaterThan(0);
    expect(await factsOn(BINDER)).toBe(1);
  }, 60_000);

  test('LOW 6: embed-backfill still embeds a Binder page with the guard on (run, not read)', async () => {
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
    await engine.setConfig('embedding_dimensions', '1536');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'synthetic-only' } } as never);
    const inputs: string[] = [];
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => { inputs.push(...values);
      return { values, warnings: [], embeddings: values.map(() => vec(1536)), usage: { tokens: 8 } }; }) as never);
    await put(BINDER);
    await installFixtureChunks(engine, BINDER, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Binder chunk text for embedding.' }] as never);
    const result = await withEnv({ [GUARD]: undefined, GBRAIN_HOME: home }, () => makeEmbedBackfillHandler(engine)(ctx('embed-backfill', 1, { sourceId: 'default' }))) as unknown as Record<string, unknown>;
    expect(result.embedded).toBe(1);
    expect(inputs.some(t => t.includes('Binder chunk text'))).toBe(true);
    const [row] = await engine.executeRaw<{ has: boolean }>(
      'SELECT cc.embedding IS NOT NULL AS has FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug=$1', [BINDER]);
    expect(row.has).toBe(true);
  }, 60_000);
});

describe('managed maintenance: apply side and the operator override', () => {
  const content = (narrative: string) => `---\ntype: note\ntitle: Binder\n---\n\n${narrative}\n`;
  const put = async (ctx: OperationContext, slug: string, text: string) => {
    const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
    return operationsByName.put_page.handler(ctx, { slug, content: text, ...(current ? { expected_revision: current.revision } : {}) });
  };

  test('SHOULD 2: a request admitted before the guard is prepared as a skipped no-op once the guard is on', () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, BINDER, content('Hand-written Binder text.'));
    const before = await engine.readPageSnapshot(BINDER, { sourceId: 'default' });
    const authority = (await maintenancePreflight(engine, 'default', root))!;
    const receipt = await withEnv({ [GUARD]: 'off' }, () => publishMaintenancePage(engine, authority, BINDER, content('A maintenance rewrite.'), { expectedRevision: before!.revision }));
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1', [receipt.request_id]);
    const config = { engine: engine.kind } as never;
    const onPrepared = await withEnv({ [GUARD]: undefined }, () => prepareMaintenanceMutation(engine, row, config));
    expect(onPrepared.noop).toBe(true);
    expect(await onPrepared.apply(engine as never)).toMatchObject({ status: 'skipped', reason: SKIP });
    // Guard off, the same kind of request against the current revision prepares a real write again.
    const current = (await engine.readPageSnapshot(BINDER, { sourceId: 'default' }))!;
    const fresh = { ...row, intent: { ...row.intent, content: content('A second maintenance rewrite.'), expected_revision: current.revision } } as WriteRequest;
    const offPrepared = await withEnv({ [GUARD]: 'off' }, () => prepareMaintenanceMutation(engine, fresh, config));
    expect(offPrepared.noop).not.toBe(true);
  }), 120_000);

  test('SHOULD 5: a named per-request operator override admits one write on a Binder page and logs it; without it the write is refused', () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, BINDER, content('Hand-written Binder text.'));
    const before = await engine.readPageSnapshot(BINDER, { sourceId: 'default' });
    const authority = (await maintenancePreflight(engine, 'default', root))!;
    await withEnv({ [GUARD]: undefined }, async () => {
      const refused = await publishMaintenancePage(engine, authority, BINDER, content('A repair.'), { expectedRevision: before!.revision })
        .then(() => null, (e: { detail?: unknown }) => e);
      expect(refused).toMatchObject({ detail: SKIP });
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      let receipt: Record<string, unknown>;
      try {
        receipt = await publishMaintenancePage(engine, authority, BINDER, content('A repair.'),
          { expectedRevision: before!.revision, protectedPageOverride: { operator: 'lgv', reason: 'ghost page retirement' } });
      } finally { console.error = original; }
      expect(receipt!.state).toBe('committed');
      expect(logged.some(l => l.includes('operator override') && l.includes(BINDER) && l.includes('ghost page retirement'))).toBe(true);
    });
  }), 120_000);
});
