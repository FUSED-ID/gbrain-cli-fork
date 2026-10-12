import type { BrainEngine } from './engine.ts';

export interface OauthV127SelfhealResult {
  repaired: boolean;
  present: boolean;
}

/** Repair upstream v127 artifacts skipped by a fork-era v127 stamp. */
export async function repairOauthV127Artifacts(engine: BrainEngine): Promise<OauthV127SelfhealResult> {
  const columns = await engine.executeRaw<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'oauth_clients'
         AND column_name IN ('surface', 'surface_set_by')`,
  );
  const index = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('idx_minion_jobs_queue_status_updated')::text AS reg`,
  );
  const haveSurface = columns.some((row) => row.column_name === 'surface');
  const haveSurfaceSetBy = columns.some((row) => row.column_name === 'surface_set_by');
  const haveIndex = Boolean(index[0]?.reg);
  if (haveSurface && haveSurfaceSetBy && haveIndex) return { repaired: false, present: true };

  await engine.executeRaw(`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface TEXT`);
  await engine.executeRaw(`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface_set_by TEXT`);
  await engine.executeRaw(`CREATE INDEX IF NOT EXISTS idx_minion_jobs_queue_status_updated ON minion_jobs (queue, status, updated_at)`);
  return { repaired: true, present: false };
}
