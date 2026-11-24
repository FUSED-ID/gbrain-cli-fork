/**
 * LGV ruling 2026-11-24, second pass: every worker write to a protected Binder
 * page is refused, not only the three job handlers. Covers the chronicle cycle
 * phase (ledger rows, discovery, rows queued before the guard), the facts
 * backstop entry, the fence writer, the unfenced-facts fencer (extract_facts
 * phase) and the maintenance coordinator (every managed cycle write).
 * Red/green: guard on (default) refuses with protected_binder_page; guard off
 * (GBRAIN_PROTECTED_SLUG_PATTERNS set to a non-matching glob) writes as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import type { ChronicleJudge, ChronicleJudgeResult } from '../src/core/chronicle/extract-events.ts';
import { resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { _resetBudgetTrackerWarningsForTest } from '../src/core/budget/budget-tracker.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { maintenancePreflight, publishMaintenancePage } from '../src/core/persistence/prepared-maintenance.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';

const SKIP = 'protected_binder_page';
const ENV = 'GBRAIN_PROTECTED_SLUG_PATTERNS';
const OFF = 'no-such-page-*';
const BINDER_MEETING = 'meetings/binder-gbrain-conops-doc-family-2026-11-24';
const PLAIN_MEETING = 'meetings/plain-sync';
const BINDER = 'docs/binder-gbrain-conops-doc-family-2026-11-24-t2';
const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const meeting = (title: string) => `---\ntype: meeting\ntitle: ${title}\ndate: ${today}\n---\n\n${BODY}`;
const ev = (what: string) => ({ when: today, who: ['people/alice-example'], what, kind: 'commitment' });

const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run);
async function put(ctx: OperationContext, slug: string, content: string) {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  return await operationsByName.put_page.handler(ctx, { slug, content, ...(current ? { expected_revision: current.revision } : {}) }) as Record<string, unknown>;
}
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
function judgeFor() {
  const seen: string[] = [];
  const judge = (async (input: { slug?: string; page?: { slug?: string } } & Record<string, unknown>) => {
    seen.push(String(input?.slug ?? input?.page?.slug ?? JSON.stringify(input).slice(0, 80)));
    return { events: [ev(`Agreed in ${seen.length}`)] } as ChronicleJudgeResult;
  }) as unknown as ChronicleJudge;
  return { judge, seen };
}
const ledger = (engine: BrainEngine, slug: string) => engine.executeRaw<{ state: string; reason: string | null }>(
  'SELECT state, reason FROM chronicle_page_state WHERE slug=$1 ORDER BY decided_at', [slug]);
const hashOf = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ content_hash: string }>("SELECT content_hash FROM pages WHERE slug=$1 AND source_id='default'", [slug]))[0]?.content_hash;

afterEach(() => { __setChatTransportForTests(null); resetGateway(); _resetBudgetTrackerWarningsForTest(); });

describe('chronicle cycle phase', () => {
  test('guard on: a Binder meeting gets no ledger row and no events; the plain meeting still extracts', () => withEnv({ [ENV]: undefined }, () => brain(async ({ engine, ctx }) => {
    await put(ctx, BINDER_MEETING, meeting('Binder'));
    await put(ctx, PLAIN_MEETING, meeting('Plain'));
    await settle(engine);
    const before = await hashOf(engine, BINDER_MEETING);
    const { judge } = judgeFor();
    const r = await runPhaseChronicle(engine, { judge });
    expect(r.details).toMatchObject({ judged: 1, extracted: 1 });
    expect(await ledger(engine, BINDER_MEETING)).toEqual([]);
    expect(await ledger(engine, PLAIN_MEETING)).toEqual([expect.objectContaining({ state: 'extracted' })]);
    expect(await hashOf(engine, BINDER_MEETING)).toBe(before);
  })), 120_000);

  test('guard on: a row queued for a Binder meeting before the guard settles as skipped protected_binder_page, unjudged', () => brain(async ({ engine, ctx }) => {
    await withEnv({ [ENV]: OFF }, () => put(ctx, BINDER_MEETING, meeting('Binder')));
    await settle(engine);
    expect(await ledger(engine, BINDER_MEETING)).toEqual([expect.objectContaining({ state: 'pending' })]);
    const { judge } = judgeFor();
    const r = await withEnv({ [ENV]: undefined }, () => runPhaseChronicle(engine, { judge }));
    expect(r.details).toMatchObject({ judged: 0, events_written: 0 });
    expect(await ledger(engine, BINDER_MEETING)).toEqual([{ state: 'skipped', reason: SKIP }]);
  }), 120_000);

  test('guard off: the Binder meeting is extracted as before', () => withEnv({ [ENV]: OFF }, () => brain(async ({ engine, ctx }) => {
    await put(ctx, BINDER_MEETING, meeting('Binder'));
    await settle(engine);
    const { judge } = judgeFor();
    const r = await runPhaseChronicle(engine, { judge });
    expect(r.details).toMatchObject({ judged: 1, extracted: 1 });
    expect(await ledger(engine, BINDER_MEETING)).toEqual([expect.objectContaining({ state: 'extracted' })]);
  })), 120_000);
});

describe('maintenance coordinator (every managed cycle write)', () => {
  const content = (narrative: string) => `---\ntype: note\ntitle: Binder\n---\n\n${narrative}\n`;
  test('guard on: a maintenance page write to a Binder page is refused with protected_binder_page; the page is unchanged', () => withEnv({ [ENV]: undefined }, () => brain(async ({ engine, ctx, root }) => {
    await put(ctx, BINDER, content('Hand-written Binder text.'));
    const before = await engine.readPageSnapshot(BINDER, { sourceId: 'default' });
    const authority = (await maintenancePreflight(engine, 'default', root))!;
    const err = await publishMaintenancePage(engine, authority, BINDER, content('A maintenance rewrite.'), { expectedRevision: before!.revision })
      .then(() => null, (e: { code?: string; detail?: unknown }) => e);
    expect(err).toMatchObject({ code: 'permission_denied', detail: SKIP });
    expect((await engine.readPageSnapshot(BINDER, { sourceId: 'default' }))!.revision).toBe(before!.revision);
  })), 120_000);
  test('guard off: the same maintenance write commits as before', () => withEnv({ [ENV]: OFF }, () => brain(async ({ engine, ctx, root }) => {
    await put(ctx, BINDER, content('Hand-written Binder text.'));
    const before = await engine.readPageSnapshot(BINDER, { sourceId: 'default' });
    const authority = (await maintenancePreflight(engine, 'default', root))!;
    const receipt = await publishMaintenancePage(engine, authority, BINDER, content('A maintenance rewrite.'), { expectedRevision: before!.revision });
    expect(receipt.state).toBe('committed');
  })), 120_000);
});

describe('facts writers (unmanaged brain)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', String(LATEST_VERSION)); });
  const fact = { fact: 'Alice Example agreed to ship the beta', kind: 'fact', visibility: 'private', notability: 'high', source: 'mcp:put_page', confidence: 1 } as const;
  const backstop = (slug: string) => runFactsBackstop({ slug, type: 'note', compiled_truth: BODY.repeat(4), frontmatter: {} } as never,
    { engine, config: { engine: 'pglite' }, sourceId: 'default', source: 'mcp:put_page', mode: 'inline' } as never);

  test('guard on: the facts backstop skips a Binder page with protected_binder_page', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => backstop(BINDER));
    expect(r.skipped).toBe(SKIP);
  });
  test('guard off: the backstop does not skip it for protection', async () => {
    const r = await withEnv({ [ENV]: OFF }, () => backstop(BINDER));
    expect(r.skipped).not.toBe(SKIP);
  });
  test('guard on: the fence writer writes nothing for a Binder entity and asks for no DB-only fallback', async () => {
    const r = await withEnv({ [ENV]: undefined }, () => writeFactsToFence(engine, { sourceId: 'default', localPath: null, slug: BINDER, resolutionSource: 'exact_page' }, [fact as never]));
    expect(r).toEqual({ inserted: 0, ids: [], protectedSkipped: true });
  });
  test('guard off: the fence writer takes its usual path', async () => {
    const r = await withEnv({ [ENV]: OFF }, () => writeFactsToFence(engine, { sourceId: 'default', localPath: null, slug: BINDER, resolutionSource: 'exact_page' }, [fact as never]));
    expect(r.protectedSkipped).toBeUndefined();
    expect(r.legacyFallback).toBe(true);
  });
  test('guard on/off: the unfenced-facts fencer leaves rows about a Binder entity out of its plan', async () => {
    await engine.putPage(BINDER, { type: 'note', title: 'Binder', compiled_truth: BODY, timeline: '', frontmatter: {} } as never);
    await engine.insertFact({ ...fact, entity_slug: BINDER } as never, { source_id: 'default' });
    const on = await withEnv({ [ENV]: undefined }, () => planUnfencedFacts(engine, { sourceId: 'default' }));
    expect(on.outcome.skipped_protected).toBe(1);
    const off = await withEnv({ [ENV]: OFF }, () => planUnfencedFacts(engine, { sourceId: 'default' }));
    expect(off.outcome.skipped_protected).toBeUndefined();
  });
});
