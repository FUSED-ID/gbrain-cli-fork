/**
 * #D10-live — session_context_state schema-drift self-heal.
 *
 * Upstream v0.45.12 ships migration v126 (`session_context_state`). The
 * FUSED-ID fork historically occupied slot 126 (and stamped some brains to
 * 127) with `oauth_and_access_token_permissions` before the 2026-08-21
 * renumber (fork slot is now v127). A brain stamped 126/127 by the OLD fork
 * numbering therefore has its version counter PAST v126 while the
 * `session_context_state` table never got created — `runMigrations` cannot
 * see the drift (pending filters on version > current), and ambient-recall
 * code that assumes the table exists fails at runtime.
 *
 * Same disease and same cure as #2038 (timeline-dedup-repair): the version
 * counter cannot detect this, so the repair keys off the actual artifact and
 * runs on every migrate pass, including the no-pending path. The DDL is the
 * exact body of upstream v126 and is fully idempotent.
 */

import type { BrainEngine } from './engine.ts';

export interface SessionContextSelfhealResult {
  /** Table was absent and has been created by this pass. */
  repaired: boolean;
  /** Table was already present (no-op). */
  present: boolean;
}

export async function repairSessionContextState(engine: BrainEngine): Promise<SessionContextSelfhealResult> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('session_context_state')::text AS reg`,
  );
  const present = Boolean(tbl[0]?.reg);
  if (present) return { repaired: false, present: true };

  // Exact upstream v126 body (idempotent by construction).
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS session_context_state (
      source_id         TEXT NOT NULL,
      client_id         TEXT NOT NULL DEFAULT 'local',
      session_id        TEXT NOT NULL,
      standing_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
      surfaced_slugs    JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_wake_at      TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source_id, client_id, session_id)
    );
  `);
  await engine.executeRaw(`
    CREATE INDEX IF NOT EXISTS session_context_state_updated_idx
      ON session_context_state (updated_at);
  `);
  return { repaired: true, present: false };
}
