import { describe, expect, test } from 'bun:test';
import { sourcesOperations } from '../src/core/ops/sources.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const sourcesRemove = sourcesOperations.find((op) => op.name === 'sources_remove');

if (!sourcesRemove) {
  throw new Error('sources_remove operation is missing from sourcesOperations');
}

const factsOnlyEngine = {
  executeRaw: async <T>(sql: string): Promise<T[]> => {
    if (sql.includes('FROM sources')) {
      return [{
        id: 'facts-only',
        name: 'Facts only',
        local_path: null,
        last_commit: null,
        last_sync_at: null,
        config: {},
        created_at: new Date(),
      }] as T[];
    }
    return [{ page_count: 0, fact_count: 1, chunk_count: 0 }] as T[];
  },
} as unknown as BrainEngine;

const operationContext: OperationContext = {
  engine: factsOnlyEngine,
  config: {} as OperationContext['config'],
  logger: console,
  dryRun: false,
  remote: true,
  sourceId: 'facts-only',
};

describe('sources_remove operation declaration', () => {
  test("keeps scope exactly 'sources_admin'", () => {
    // The remote reachability of sources_remove is DELIBERATE as of 2026-09-19.
    // A live remote caller exists at test/e2e/sources-remote-mcp.test.ts:373,
    // so making this localOnly would break thin clients silently. It is guarded
    // instead by the confirmation gate in removeSource, which refuses when the
    // source has pages OR facts OR chunks. If you are here because you want to
    // close route 7 properly, the decision is LGV's, and changing this
    // declaration without changing that caller is not the way.
    expect(sourcesRemove.scope).toBe('sources_admin');
  });

  test('keeps localOnly absent deliberately for the live thin-client route', () => {
    // The remote reachability of sources_remove is DELIBERATE as of 2026-09-19.
    // A live remote caller exists at test/e2e/sources-remote-mcp.test.ts:373,
    // so making this localOnly would break thin clients silently. It is guarded
    // instead by the confirmation gate in removeSource, which refuses when the
    // source has pages OR facts OR chunks. If you are here because you want to
    // close route 7 properly, the decision is LGV's, and changing this
    // declaration without changing that caller is not the way.
    expect(sourcesRemove.localOnly).toBeUndefined();
  });

  test('declares the confirmation and dry-run parameters', () => {
    // The remote reachability of sources_remove is DELIBERATE as of 2026-09-19.
    // A live remote caller exists at test/e2e/sources-remote-mcp.test.ts:373,
    // so making this localOnly would break thin clients silently. It is guarded
    // instead by the confirmation gate in removeSource, which refuses when the
    // source has pages OR facts OR chunks. If you are here because you want to
    // close route 7 properly, the decision is LGV's, and changing this
    // declaration without changing that caller is not the way.
    expect(sourcesRemove.params).toEqual(expect.objectContaining({
      confirm_destructive: expect.any(Object),
      dry_run: expect.any(Object),
    }));
  });

  test('without confirm_destructive, refuses a source with only facts and zero pages', async () => {
    // The confirmation gate is the deliberate protection for the remotely
    // reachable operation: facts count as data even when pages and chunks are
    // both zero, so an unconfirmed cascading delete must refuse.
    await expect(sourcesRemove.handler(operationContext, { id: 'facts-only' }))
      .rejects.toThrow(/0 pages, 1 facts, and 0 chunks without --confirm-destructive/);
  });
});
