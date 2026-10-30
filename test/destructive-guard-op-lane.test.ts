/**
 * R4 seam review for the v0.60.473 operation surface.
 *
 * The newer operation contract keeps purge_deleted_pages local-only and
 * performs consent in the coordinated persistence library. This test pins
 * that stronger upstream boundary without reopening the older handler grammar.
 */
import { describe, expect, test } from 'bun:test';
import { pagesOperations } from '../src/core/ops/pages.ts';

const op = pagesOperations.find((o) => o.name === 'purge_deleted_pages');

function stubCtx(dryRun = false, remote = true) {
  const calls: number[] = [];
  const ctx = {
    dryRun,
    remote,
    engine: {
      executeRaw: async () => [{ enabled: false }],
      purgeDeletedPages: async (hours: number) => {
        calls.push(hours);
        return { count: 0, slugs: [] };
      },
    },
  } as never;
  return { ctx, calls };
}

describe('v0.60.473 purge_deleted_pages operation seam', () => {
  test('the operation remains registered and local-only', () => {
    expect(op).toBeDefined();
    expect(op?.cliHints?.name).toBe('purge-deleted');
    expect(op?.localOnly).toBe(true);
  });

  test('remote execution refuses before the purge arm', async () => {
    const { ctx, calls } = stubCtx(false, true);
    await expect(op!.handler(ctx, { older_than_hours: 72, yes: true } as never))
      .rejects.toThrow(/trusted local CLI/);
    expect(calls).toHaveLength(0);
  });

  test('dry-run remains read-only and does not require a database call', async () => {
    const { ctx, calls } = stubCtx(true, true);
    const result = await op!.handler(ctx, {} as never);
    expect(result).toMatchObject({ dry_run: true, older_than_hours: 72 });
    expect(calls).toHaveLength(0);
  });

  test('local execution uses the upstream default cutoff and consent parameter', async () => {
    const { ctx, calls } = stubCtx(false, false);
    const result = await op!.handler(ctx, { older_than_hours: 72, yes: true } as never);
    expect(result).toMatchObject({ status: 'purged', count: 0 });
    expect(calls).toEqual([72]);
  });

  test('the description documents the upstream default and local boundary', () => {
    expect(op!.description).toMatch(/default 72/i);
    expect(op!.description).toMatch(/Trusted local CLI/i);
  });
});
