/**
 * Defect 2 fix (binding NO-GO, 20260915): the tombstone race guard's
 * writeStartedAt was captured client-side at millisecond resolution and
 * compared against a microsecond `deleted_at`, so a same-millisecond
 * putPage-after-softDelete revival (exactly what src/commands/sync.ts's
 * soft-delete-then-reimport passes do) read as a concurrent delete and threw.
 *
 * Measured before the fix, 300 iterations of putPage / softDeletePages /
 * putPage on one slug: PGLite refused 204/300, PostgresEngine (scratch DB)
 * refused 196/300, upstream 03436b64b refused 0/300.
 *
 * This file re-runs that exact loop against both engines and asserts 0
 * refusals, matching upstream 03436b64b. PostgresEngine only runs when
 * DATABASE_URL is set to an explicitly test-shaped database (same opt-in
 * convention as postgres-engine-private-routing.test.ts); PGLite always runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const ITERATIONS = 300;

async function revivalLoop(engine: BrainEngine, slugPrefix: string): Promise<{ refused: number; errors: string[] }> {
  let refused = 0;
  const errors: string[] = [];
  const slug = `${slugPrefix}-revival-loop-target`;
  await engine.putPage(slug, {
    type: 'note', title: 'Revival Loop Seed', compiled_truth: 'seed body', timeline: '', frontmatter: {},
  }, { sourceId: 'default' });

  for (let i = 0; i < ITERATIONS; i++) {
    // Mirrors src/commands/sync.ts's soft-delete-then-reimport shape: soft
    // delete immediately followed by a putPage on the SAME slug, with no
    // artificial delay -- this is what makes the race land in the same
    // millisecond under real bulk-sync timing.
    await engine.softDeletePages([slug], { sourceId: 'default' });
    try {
      await engine.putPage(slug, {
        type: 'note', title: 'Revival Loop Revived', compiled_truth: `revival ${i}`, timeline: '', frontmatter: {},
      }, { sourceId: 'default' });
    } catch (error) {
      refused++;
      errors.push(String(error));
    }
  }
  return { refused, errors };
}

describe('defect 2: same-millisecond revival is never refused', () => {
  describe('PGLiteEngine', () => {
    let engine: PGLiteEngine;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }, 240000);

    afterAll(async () => {
      await engine.disconnect();
    }, 120000);

    beforeEach(async () => {
      await resetPgliteState(engine);
    });

    test(`0/${ITERATIONS} refusals on same-millisecond putPage-after-softDelete`, async () => {
      const { refused, errors } = await revivalLoop(engine, 'pglite-tombstone');
      if (refused > 0) {
        console.log(`PGLite revival loop: ${refused}/${ITERATIONS} refused. Sample: ${errors[0]}`);
      }
      expect(refused).toBe(0);
    }, 60000);
  });

  const DATABASE_URL = process.env.DATABASE_URL;
  const describeIfDb = DATABASE_URL ? describe : describe.skip;

  describeIfDb('PostgresEngine', () => {
    let engine: PostgresEngine;

    beforeAll(async () => {
      if (!DATABASE_URL) return;
      assertSafeE2eDatabaseUrl(DATABASE_URL);
      engine = new PostgresEngine();
      await engine.connect({ database_url: DATABASE_URL, poolSize: 3 });
      await engine.initSchema();
    }, 120000);

    afterAll(async () => {
      if (!engine) return;
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'pg-tombstone-revival-loop-target'`);
      await engine.disconnect();
    });

    test(`0/${ITERATIONS} refusals on same-millisecond putPage-after-softDelete (PostgresEngine)`, async () => {
      const { refused, errors } = await revivalLoop(engine, 'pg-tombstone');
      if (refused > 0) {
        console.log(`PostgresEngine revival loop: ${refused}/${ITERATIONS} refused. Sample: ${errors[0]}`);
      }
      expect(refused).toBe(0);
    }, 60000);
  });
});
