/**
 * LGV ruling 2026-11-24: the worker refuses body, fact and atom writes to
 * protected Binder pages (slug matches binder-gbrain-conops-doc-family-*,
 * any directory prefix, any source) with the skip code
 * `protected_binder_page`. The job completes, it does not fail. Embedding is
 * not touched. GBRAIN_PROTECTED_SLUG_PATTERNS adds patterns to the default;
 * GBRAIN_PROTECTED_BINDER_GUARD=off is the only way to turn the guard off.
 *
 * Red/green pairs: guard on (default) -> each of facts-absorb,
 * chronicle_extract and extract_atoms writes nothing for the Binder page and
 * reports the skip code; guard off -> the same handler writes as before; a
 * non-Binder page still writes with the guard on. Stub transports only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { makeChronicleExtractHandler } from '../src/core/minions/handlers/chronicle-extract.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const SKIP = 'protected_binder_page';
const ENV = 'GBRAIN_PROTECTED_BINDER_GUARD';
const OFF = 'off';
const BINDER = 'docs/binder-gbrain-conops-doc-family-2026-11-24-t1';
const BINDER_ROOT = 'binder-gbrain-conops-doc-family-2026-11-23';
const PLAIN = 'notes/plain-example';
const today = new Date().toISOString().slice(0, 10);
const BODY = `Alice Example agreed to ship the beta on ${today}. ${'A substantive project record with names, dates and decisions about the launch plan. '.repeat(10)}`;

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); home = mkdtempSync(join(tmpdir(), 'gbrain-binderguard-')); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_VERSION)); });
afterEach(() => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway(); });

const reply = (text: string, model = 'anthropic:claude-sonnet-4-6'): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', model, providerId: 'anthropic',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult);

async function put(slug: string, type = 'note', frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type, title: slug, compiled_truth: BODY, timeline: '', frontmatter } as never);
}
async function hash(slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ content_hash: string; compiled_truth: string }>("SELECT content_hash, compiled_truth FROM pages WHERE slug=$1 AND source_id='default'", [slug]);
  return `${row.content_hash}:${row.compiled_truth.length}`;
}
const factCount = async (slug: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM facts WHERE source_id='default' AND (entity_slug=$1 OR source_markdown_slug=$1)", [slug]))[0].n;

function ctx(name: string, id: number, data: Record<string, unknown>): MinionJobContext {
  const signal = new AbortController().signal;
  return { id, name, data, attempts_made: 0, signal, deadlineAtMs: null, shutdownSignal: signal, updateProgress: async () => {}, updateTokens: async () => {},
    log: async () => {}, isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
}

async function runFactsAbsorb(slug: string) {
  await put(slug);
  const before = await hash(slug);
  const job = await new MinionQueue(engine).add('facts-absorb', { slug, sourceId: 'default', source: 'mcp:put_page', notabilityFilter: 'all', visibility: 'private' });
  let chats = 0;
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' } } as never);
  await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
  __setChatTransportForTests(async (opts: ChatOpts) => { chats++; return reply(JSON.stringify({ facts: [
    { fact: 'Alice Example agreed to ship the beta', kind: 'fact', entity: slug, confidence: 1, notability: 'high' }] }), opts.model); });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => { const v = new Array<number>(1536).fill(0); v[0] = 1; return v; }) })) as never);
  const result = await withEnv({ GBRAIN_HOME: home }, () => makeFactsAbsorbHandler(engine)(ctx('facts-absorb', job.id, job.data as Record<string, unknown>))) as Record<string, unknown>;
  return { result, before, after: await hash(slug), chats, facts: await factCount(slug) };
}

async function runChronicle(slug: string) {
  await put(slug, 'meeting', { date: today });
  const before = await hash(slug);
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } } as never);
  let chats = 0;
  __setChatTransportForTests(async (opts: ChatOpts) => { chats++;
    return reply(JSON.stringify([{ when: today, who: ['people/alice-example'], what: 'Alice agreed to ship the beta', kind: 'commitment' }]), opts.model); });
  const result = await makeChronicleExtractHandler(engine)(ctx('chronicle_extract', 1, { slug, sourceId: 'default' })) as Record<string, unknown>;
  const rows = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chronicle_page_state WHERE slug=$1', [slug]))[0].n;
  const events = (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type='event' AND deleted_at IS NULL"))[0].n;
  return { result, before, after: await hash(slug), chats, rows, events };
}

async function runAtoms(slug: string, seam: boolean) {
  await put(slug);
  const before = await hash(slug);
  const [p] = await engine.executeRaw<{ content_hash: string }>("SELECT content_hash FROM pages WHERE slug=$1", [slug]);
  let chats = 0;
  const chat = async (opts: ChatOpts): Promise<ChatResult> => { chats++;
    return reply(JSON.stringify([{ title: `Beta ship decision ${slug}`, body: 'Alice Example agreed to ship the beta.', atom_type: 'insight' }]), 'anthropic:claude-haiku-4-5'); };
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: chat as never, _transcripts: [],
    ...(seam ? { _pages: [{ slug, content: BODY, contentHash: p.content_hash }] } : {}) });
  const atoms = (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type='atom' AND frontmatter->>'source_slug'=$1 AND deleted_at IS NULL", [slug]))[0].n;
  return { result, details: result.details as Record<string, unknown>, before, after: await hash(slug), chats, atoms };
}

describe('the protected-slug predicate', () => {
  test('default matches the Binder family at any directory prefix; a configured pattern list replaces it', async () => {
    const { isProtectedBinderPage } = await import('../src/core/persistence/protected-binder-pages.ts');
    await withEnv({ [ENV]: undefined }, async () => {
      expect(isProtectedBinderPage(BINDER)).toBe(true);
      expect(isProtectedBinderPage(BINDER_ROOT)).toBe(true);
      expect(isProtectedBinderPage('a/b/BINDER-gbrain-conops-doc-family-x')).toBe(true);
      expect(isProtectedBinderPage(PLAIN)).toBe(false);
      expect(isProtectedBinderPage('notes/about-binder-gbrain-conops')).toBe(false);
    });
    await withEnv({ [ENV]: OFF }, async () => { expect(isProtectedBinderPage(BINDER)).toBe(false); });
    await withEnv({ GBRAIN_PROTECTED_SLUG_PATTERNS: 'notes/*, x' }, async () => { expect(isProtectedBinderPage(PLAIN)).toBe(true); expect(isProtectedBinderPage(BINDER)).toBe(true); });
  });
});

describe('facts-absorb', () => {
  test('guard on: a Binder page is skipped with protected_binder_page; no fence write, no facts, no chat', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => runFactsAbsorb(BINDER));
    expect(r.result.skipped).toBe(SKIP);
    expect(r.after).toBe(r.before);
    expect(r.facts).toBe(0);
    expect(r.chats).toBe(0);
  }, 60_000);
  test('guard off: the same Binder page is extracted as before', async () => {
    const r = await withEnv({ [ENV]: OFF }, () => runFactsAbsorb(BINDER));
    expect(r.result.skipped).not.toBe(SKIP);
    expect(r.chats).toBeGreaterThan(0);
  }, 60_000);
  test('guard on: a non-Binder page still extracts', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => runFactsAbsorb(PLAIN));
    expect(r.result.skipped).not.toBe(SKIP);
    expect(r.chats).toBeGreaterThan(0);
  }, 60_000);
});

describe('chronicle_extract', () => {
  test('guard on: a Binder page is skipped with protected_binder_page; no ledger row, no events, no chat', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => runChronicle(BINDER));
    expect(r.result).toMatchObject({ status: 'skipped', skipped: SKIP });
    expect(r.after).toBe(r.before);
    expect(r.rows).toBe(0);
    expect(r.events).toBe(0);
    expect(r.chats).toBe(0);
  }, 60_000);
  test('guard off: the same Binder page is extracted as before', async () => {
    const r = await withEnv({ [ENV]: OFF }, () => runChronicle(BINDER));
    expect(r.result).toMatchObject({ status: 'extracted', events_written: 1 });
    expect(r.rows).toBeGreaterThan(0);
  }, 60_000);
  test('guard on: a non-Binder page still extracts', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => runChronicle(PLAIN));
    expect(r.result).toMatchObject({ status: 'extracted', events_written: 1 });
  }, 60_000);
});

describe('extract_atoms (the per-page writer extract-atoms-drain runs)', () => {
  test('guard on: a Binder page handed to the phase is skipped with protected_binder_page; no atoms, no chat', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => runAtoms(BINDER, true));
    expect(r.details.protected_skipped).toEqual([{ slug: BINDER, skipped: SKIP }]);
    expect(r.atoms).toBe(0);
    expect(r.chats).toBe(0);
    expect(r.after).toBe(r.before);
  }, 60_000);
  test('guard on: discovery and the backlog count leave a Binder page out, so the drain neither spins on it nor counts it', async () => {
    await withEnv({ [ENV]: undefined }, async () => {
      await put(BINDER); await put(PLAIN);
      expect((await discoverExtractablePages(engine, 'default')).map(p => p.slug)).toEqual([PLAIN]);
      expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
      expect(await countExtractAtomsBacklog(engine)).toBe(1);
    });
  }, 60_000);
  test('guard off: the same Binder page is discovered and extracted as before', async () => {
    const r = await withEnv({ [ENV]: OFF }, () => runAtoms(BINDER, false));
    expect(r.details.protected_skipped ?? []).toEqual([]);
    expect(r.chats).toBe(1);
    expect(r.atoms).toBeGreaterThan(0);
  }, 60_000);
  test('guard on: a non-Binder page still extracts', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => runAtoms(PLAIN, false));
    expect(r.chats).toBe(1);
    expect(r.atoms).toBeGreaterThan(0);
  }, 60_000);
});
