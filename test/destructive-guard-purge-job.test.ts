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
 */
import { describe, expect, test } from 'bun:test';
import { PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';

describe('R4 fourth route — the purge job is remote-submittable', () => {
  test("'purge' is protected, so an MCP caller cannot enqueue it", () => {
    // submit_job sets allowProtectedSubmit only when ctx.remote === false.
    expect(PROTECTED_JOB_NAMES.has('purge')).toBe(true);
  });

  test('the names that were already protected stay protected', () => {
    for (const name of ['shell', 'subagent', 'subagent_aggregator']) {
      expect(PROTECTED_JOB_NAMES.has(name)).toBe(true);
    }
  });
});

/**
 * The handler itself is registered inside runJobs' worker wiring, which needs a
 * queue to reach. These tests pin the CONTRACT against the source text instead,
 * which is the same technique test/helpers/doctor-source.ts uses for checks that
 * cannot be constructed in isolation. A behavioural test would be better; a
 * source pin that fails loudly when the guard is removed is much better than
 * nothing on a path that deleted 2,582 pages.
 */
describe('R4 fourth route — the purge job handler contract', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'),
    'utf8',
  ) as string;
  const handler = source.slice(
    source.indexOf("worker.register('purge'"),
    source.indexOf("worker.register('purge'") + 4200,
  );

  test('the silent 72h default is gone', () => {
    expect(handler).not.toMatch(/olderThanHours\s*:\s*number\s*\?[^]*?:\s*72/);
    expect(handler).not.toContain("typeof job.data.olderThanHours === 'number' ? job.data.olderThanHours : 72");
    expect(handler).toContain('olderThanHours is required');
  });

  test('a real run requires the same literal consent string as every other route', () => {
    expect(handler).toContain("job.data.confirm !== 'yes-i-mean-it'");
    expect(handler).toContain('refusing to hard-delete without explicit consent');
  });

  test('dryRun is actually passed through, not just reported', () => {
    // The defect was `purgeDeletedPages(olderThanHours)` with dryRun computed
    // and discarded, then returned in the result object as if it had applied.
    expect(handler).toContain('dryRun ? { dryRun: true } : undefined');
    expect(handler).not.toMatch(/purgeDeletedPages\(olderThanHours\)\s*;/);
  });

  test('a dry run does not purge sources or checkpoints either', () => {
    expect(handler).toContain("if (!dryRun && (scope === 'sources' || scope === 'all'))");
    expect(handler).toContain('if (!dryRun) {');
  });
});
