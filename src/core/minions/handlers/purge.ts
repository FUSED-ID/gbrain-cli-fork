/**
 * `purge` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makePurgeHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const scope = (typeof job.data.scope === 'string' && ['pages', 'sources', 'all'].includes(job.data.scope))
      ? (job.data.scope as 'pages' | 'sources' | 'all')
      : 'all';
    const dryRun = !!job.data.dryRun;
    const olderThanHours = job.data.olderThanHours;
    if (typeof olderThanHours !== 'number' || !Number.isFinite(olderThanHours) || olderThanHours < 0) throw new Error('olderThanHours is required');
    if (!dryRun && job.data.confirm !== 'yes-i-mean-it') throw new Error('refusing purge without explicit consent');
    let pagesPurged = 0;
    let pagesBlocked: Array<{ source_id: string; slug: string; reason: string }> = [];
    let pagesError: string | undefined;
    let sourcesPurged: string[] = [];
    if (scope === 'pages' || scope === 'all') {
      if (dryRun || typeof engine.readPageSnapshot !== 'function') {
        pagesPurged = (await engine.purgeDeletedPages(olderThanHours, dryRun ? { dryRun: true } : undefined)).count;
      } else {
        // #7130: keep managed sync tombstones with no live twin, like the cycle phase.
        const result = await (await import('../../persistence/purge-deleted.ts')).purgeDeletedPagesCoordinated(engine, olderThanHours, { automatic: true });
        pagesPurged = result.count; pagesBlocked = result.blocked; pagesError = result.error?.message;
      }
    }
    let sourcesBlocked: Array<{ id: string; reason: string }> = [];
    if (!dryRun && (scope === 'sources' || scope === 'all')) {
      const { purgeExpiredSources } = await import('../../destructive-guard.ts');
      const purgeResult = await purgeExpiredSources(engine);
      sourcesPurged = purgeResult.purged;
      sourcesBlocked = purgeResult.blocked;
    }
    // GC stale op_checkpoints rows (folded scope item +C from review).
    const { purgeStaleCheckpoints } = await import('../../op-checkpoint.ts');
    const checkpointsPurged = dryRun ? 0 : await purgeStaleCheckpoints(engine, 7);
    // #5405: a coordinated purge failure fails the job after the other purges ran.
    if (pagesError) throw new Error(pagesError);
    return { pagesPurged, pagesBlocked, sourcesPurged, sourcesBlocked, checkpointsPurged, dryRun };
  };
}
