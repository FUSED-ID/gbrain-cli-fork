/**
 * R4, fourth route. Found by the second Fable break pass, 2026-09-17.
 *
 * The `purge` minion job reached the same cascading hard delete as
 * `pages purge-deleted` and the `purge_deleted_pages` operation, and was the
 * worst of the four:
 *   - olderThanHours defaulted to 72, the silent default behind the incident;
 *   - `dryRun` was read from job data and then never passed to
 *     purgeDeletedPages, so a rehearsal deleted for real and RETURNED
 *     dryRun:true;
 *   - `purge` was absent from PROTECTED_JOB_NAMES, so submit_job over HTTP MCP
 *     could enqueue it, defeating the operation's localOnly:true.
 *
 * These drive the REAL registered handler through a stub worker. The first cut
 * asserted on the source text of jobs.ts, which could not have caught a
 * reordering that kept the strings but moved the consent check after the
 * delete. On a path that hard-deleted 2,582 pages, a string match is not a test.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

describe('R4 fourth route — the purge job is remote-submittable', () => {
  test("'purge' is protected, so an MCP caller cannot enqueue it", () => {
    // MinionQueue.add rejects protected names unless allowProtectedSubmit is
    // set, and submit_job only sets it when ctx.remote === false.
    expect(PROTECTED_JOB_NAMES.has('purge')).toBe(true);
  });

  test('the names that were already protected stay protected', () => {
    for (const name of ['shell', 'subagent', 'subagent_aggregator']) {
      expect(PROTECTED_JOB_NAMES.has(name)).toBe(true);
    }
  });
});

interface PurgeCall { hours: number; opts?: { dryRun?: boolean } }

/** Captures the handler registration without running a queue. */
async function purgeHandler(): Promise<{
  run: (data: Record<string, unknown>) => Promise<unknown>;
  purgeCalls: PurgeCall[];
}> {
  const handlers = new Map<string, (job: { data: Record<string, unknown> }) => Promise<unknown>>();
  const worker = {
    register: (name: string, fn: (job: { data: Record<string, unknown> }) => Promise<unknown>) => {
      handlers.set(name, fn);
    },
    registeredNames: () => [...handlers.keys()],
  } as never;

  const purgeCalls: PurgeCall[] = [];
  const engine = {
    purgeDeletedPages: async (hours: number, opts?: { dryRun?: boolean }) => {
      purgeCalls.push({ hours, opts });
      return { count: 0, slugs: [], pages: [] };
    },
    executeRaw: async () => [],
    getConfig: async () => null,
  } as unknown as BrainEngine;

  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const fn = handlers.get('purge');
  if (!fn) throw new Error('the purge handler was not registered');
  return { run: (data: Record<string, unknown>) => fn({ data }), purgeCalls };
}

describe('R4 fourth route — the purge job handler, driven for real', () => {
  test('REFUSES with no cutoff, and deletes nothing', async () => {
    const { run, purgeCalls } = await purgeHandler();
    await expect(run({ scope: 'pages' })).rejects.toThrow(/olderThanHours is required/);
    expect(purgeCalls).toHaveLength(0);
  });

  test('REFUSES a non-numeric or negative cutoff', async () => {
    for (const bad of ['72', -1, Number.NaN, null]) {
      const { run, purgeCalls } = await purgeHandler();
      await expect(run({ scope: 'pages', olderThanHours: bad })).rejects.toThrow(/olderThanHours is required/);
      expect(purgeCalls).toHaveLength(0);
    }
  });

  test('REFUSES an explicit cutoff without consent — the incident shape', async () => {
    const { run, purgeCalls } = await purgeHandler();
    await expect(run({ scope: 'pages', olderThanHours: 72 })).rejects.toThrow(/without explicit consent/);
    expect(purgeCalls).toHaveLength(0);
  });

  test('REFUSES cutoff 0 without consent — the delete-everything shape', async () => {
    const { run, purgeCalls } = await purgeHandler();
    await expect(run({ scope: 'pages', olderThanHours: 0 })).rejects.toThrow(/without explicit consent/);
    expect(purgeCalls).toHaveLength(0);
  });

  test('a dry run PASSES dryRun through — it must not delete and claim it did', async () => {
    const { run, purgeCalls } = await purgeHandler();
    const result = await run({ scope: 'pages', olderThanHours: 72, dryRun: true }) as { dryRun: boolean };
    expect(purgeCalls).toHaveLength(1);
    // This is the exact defect: dryRun was computed, discarded, and reported.
    expect(purgeCalls[0].opts).toEqual({ dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  test('a dry run needs no consent but still needs the cutoff', async () => {
    const { run } = await purgeHandler();
    await expect(run({ scope: 'pages', dryRun: true })).rejects.toThrow(/olderThanHours is required/);
  });

  test('a dry run purges no checkpoints', async () => {
    const { run } = await purgeHandler();
    const result = await run({ scope: 'pages', olderThanHours: 72, dryRun: true }) as { checkpointsPurged: number };
    expect(result.checkpointsPurged).toBe(0);
  });

  test('executes ONLY with an explicit cutoff and the literal consent string', async () => {
    const { run, purgeCalls } = await purgeHandler();
    await run({ scope: 'pages', olderThanHours: 72, confirm: 'yes-i-mean-it' });
    expect(purgeCalls).toHaveLength(1);
    expect(purgeCalls[0].hours).toBe(72);
    expect(purgeCalls[0].opts).toBeUndefined();
  });

  test('a near-miss consent value is refused', async () => {
    for (const bad of ['yes', 'YES-I-MEAN-IT', true, 1]) {
      const { run, purgeCalls } = await purgeHandler();
      await expect(run({ scope: 'pages', olderThanHours: 72, confirm: bad })).rejects.toThrow(/without explicit consent/);
      expect(purgeCalls).toHaveLength(0);
    }
  });
});
