/**
 * Protected job names — side-effect-free constant module.
 *
 * Names in this set require an explicit `trusted.allowProtectedSubmit: true` opt-in
 * when passed to `MinionQueue.add()`. The CLI path and the `submit_job` operation
 * (when `ctx.remote === false`) set the flag; MCP callers never do. Defense-in-depth
 * against in-process handlers that programmatically submit a shell child via
 * `queue.add('shell', ...)`.
 *
 * This file must stay pure — no imports from handlers, no filesystem, no env reads.
 * Queue core imports it; if this module grew side effects, every queue user would
 * pay them at module load.
 */

export const PROTECTED_JOB_NAMES: ReadonlySet<string> = new Set([
  'shell',
  // R4, 2026-09-17. `purge` hard-deletes pages and sources. The operation
  // purge_deleted_pages is localOnly:true precisely so it is "not exposed over
  // HTTP MCP", but submit_job is scope:admin and NOT localOnly, so an OAuth
  // MCP client could enqueue this job and reach the same cascading delete
  // through the worker. Protecting the name restores the local-only boundary
  // the operation already claimed to have.
  'purge',
  // R4, 2026-09-17. Both queued autopilot jobs own broad maintenance
  // surfaces and are submitted by trusted in-process scheduler paths only; a
  // remote admin token must not be able to enqueue either automatic cycle.
  'autopilot-cycle',
  'autopilot-global-maintenance',
  // v0.15: subagent + aggregator are protected because they call the
  // Anthropic API. MCP callers can't submit them directly; only the
  // `gbrain agent run` CLI path (which sets allowProtectedSubmit) or a
  // trusted local `submit_job` (ctx.remote=false) can insert these rows.
  'subagent',
  'subagent_aggregator',
  // v0.36+ brain-health-100 wave (D11 from outside-voice review):
  // synthesize, patterns, consolidate are cycle phases that internally
  // submit `subagent` children with allowProtectedSubmit=true. Treating
  // them as "data-quality maintenance" was a misread — they CAN run
  // Sonnet loops costing user money. Protected ensures only trusted
  // local callers (CLI, autopilot, doctor --remediate) can submit them;
  // an OAuth-scoped MCP client can't burn the user's API budget by
  // submitting a synthesize job over HTTP.
  'synthesize',
  'patterns',
  'consolidate',
  // v0.40.3.0 — per-chunk Haiku contextual retrieval backfill. Each job
  // potentially calls Haiku 1-50 times per page; an MCP/OAuth-scoped
  // caller submitting this in bulk could drain the user's Anthropic
  // budget. Only trusted local callers (the mode-switch hook in
  // commands/config.ts, reindex sweep, doctor --remediate) can submit.
  'contextual_reindex_per_chunk',
  // v0.41.18.0 (A12, T9) — takes-bootstrap. Per-page Haiku classifier
  // call over concept/atom/lore/briefing/writing/originals. Two-gate
  // consent (takes.bootstrap_enabled + --yes) AND PROTECTED ensures
  // no remote / MCP / autopilot path can bulk-extract takes without
  // explicit operator intent.
  'extract-takes-from-pages',
  // v0.42 type-unification (T11, plan D17). Pack-upgrade migration that
  // retypes 25K+ pages, creates 5K+ alias rows, converts edge-shaped
  // pages to link rows, AND flips the active schema pack. One-time
  // consenting user decision. PROTECTED + manual_only in
  // src/core/onboard/render.ts:toOnboardRecommendation ensures autopilot
  // can't auto-apply; user must run `gbrain onboard --auto-with-prompt`
  // or submit explicitly via `gbrain jobs submit unify-types --allow-protected`.
  'unify-types',
  // v0.42.0.0 — SkillOpt: optimizer Sonnet/Opus loops over a benchmark.
  // Preemptive register entry (v1 is CLI-only foreground; future Minion
  // handler must reject MCP submission). Costs user money (optimizer +
  // judge + rollouts) so PROTECTED is the right posture.
  'skillopt',
  // v0.42.x (#1685 GAP D, CODEX #1) — extract_atoms backlog drain. Each run
  // calls Haiku to extract atoms (~$0.30/source/run), so it MUST NOT be
  // submittable by an MCP/OAuth-scoped caller — same posture as the protected
  // `extract-takes-from-pages`. Only trusted local callers (the autopilot
  // auto-drain branch, an explicit `gbrain jobs submit extract-atoms-drain
  // --allow-protected`) can insert it.
  'extract-atoms-drain',
]);

/** Reserved queue metadata that carries the trusted submitter's claim grant. */
export const PROTECTED_CLAIM_GRANT_KEY = '__gbrain_protected_claim_grant';

/** True only for the queue-owned grant stamped by MinionQueue.add(). */
export function hasProtectedClaimGrant(data: unknown): boolean {
  return !!data && typeof data === 'object' &&
    (data as Record<string, unknown>)[PROTECTED_CLAIM_GRANT_KEY] === true;
}

/** Check a job name against the protected set. Normalizes whitespace first. */
export function isProtectedJobName(name: string): boolean {
  return PROTECTED_JOB_NAMES.has(name.trim());
}
