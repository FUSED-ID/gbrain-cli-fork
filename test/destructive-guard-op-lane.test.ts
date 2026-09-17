/**
 * R4 blocker, found by the Fable break pass on 2026-09-17.
 *
 * The command-layer guard covered `gbrain pages purge-deleted`. It did NOT
 * cover the operation, which is the OTHER route to the same hard delete:
 * `purge_deleted_pages` carries cliHints.name 'purge-deleted' and is not
 * hidden, so cli.ts registers it as the top-level command `gbrain
 * purge-deleted`, and `gbrain call purge_deleted_pages` reaches the same
 * handler. Before the fix both ran the real purge with a silent 72h default.
 *
 * These tests drive the operation handler directly, which is the single point
 * every one of those routes passes through.
 */
import { describe, expect, test } from 'bun:test';
import { pagesOperations } from '../src/core/ops/pages.ts';

const op = pagesOperations.find((o) => o.name === 'purge_deleted_pages');

function stubCtx(dryRun = false) {
  const calls: number[] = [];
  const ctx = {
    dryRun,
    engine: {
      purgeDeletedPages: async (hours: number) => {
        calls.push(hours);
        return { count: 0, slugs: [] };
      },
    },
  } as never;
  return { ctx, calls };
}

describe('R4 op lane — purge_deleted_pages', () => {
  test('the operation is registered and still reachable by its CLI name', () => {
    expect(op).toBeDefined();
    expect(op?.cliHints?.name).toBe('purge-deleted');
  });

  test('REFUSES with no cutoff, and the silent 72h default is gone', async () => {
    const { ctx, calls } = stubCtx();
    await expect(op!.handler(ctx, {} as never)).rejects.toThrow(/older_than_hours is required/);
    expect(calls.length).toBe(0);
  });

  test('REFUSES a cutoff that is not a finite non-negative number', async () => {
    for (const bad of [Number.NaN, -1, Infinity]) {
      const { ctx, calls } = stubCtx();
      await expect(op!.handler(ctx, { older_than_hours: bad } as never)).rejects.toThrow(/older_than_hours is required/);
      expect(calls.length).toBe(0);
    }
  });

  test('REFUSES an explicit cutoff without consent — the incident shape', async () => {
    const { ctx, calls } = stubCtx();
    await expect(op!.handler(ctx, { older_than_hours: 72 } as never)).rejects.toThrow(/explicit consent/);
    expect(calls.length).toBe(0);
  });

  test('REFUSES older_than_hours 0 without consent — the delete-everything shape', async () => {
    const { ctx, calls } = stubCtx();
    await expect(op!.handler(ctx, { older_than_hours: 0 } as never)).rejects.toThrow(/explicit consent/);
    expect(calls.length).toBe(0);
  });

  test('REFUSES a near-miss consent value', async () => {
    const { ctx, calls } = stubCtx();
    await expect(op!.handler(ctx, { older_than_hours: 72, confirm: 'yes' } as never)).rejects.toThrow(/explicit consent/);
    expect(calls.length).toBe(0);
  });

  test('a dry run needs the cutoff but NOT the consent flag', async () => {
    const { ctx, calls } = stubCtx(true);
    const result = await op!.handler(ctx, { older_than_hours: 72 } as never);
    expect(result).toMatchObject({ dry_run: true, older_than_hours: 72 });
    expect(calls.length).toBe(0);
  });

  test('a dry run with no cutoff is still refused', async () => {
    const { ctx } = stubCtx(true);
    await expect(op!.handler(ctx, {} as never)).rejects.toThrow(/older_than_hours is required/);
  });

  test('executes ONLY with an explicit cutoff and the literal consent string', async () => {
    const { ctx, calls } = stubCtx();
    const result = await op!.handler(ctx, { older_than_hours: 72, confirm: 'yes-i-mean-it' } as never);
    expect(result).toMatchObject({ status: 'purged', count: 0 });
    expect(calls).toEqual([72]);
  });

  test('the description no longer advertises a default', () => {
    expect(op!.description).not.toMatch(/default 72/i);
    expect(op!.description).toMatch(/no default/i);
  });
});
