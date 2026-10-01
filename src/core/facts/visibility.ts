/**
 * [ENG-8] Facts default-visibility resolver — the ONE helper behind every
 * "caller didn't say" visibility decision.
 *
 * The 'private' default used to be duplicated at four sites (backstop.ts
 * minion-payload + pipeline, operations.ts extract_facts + ontology_propose),
 * and the op-layer ternaries coerced ANY non-'world' value — including unset —
 * to 'private' before a config default could run. This module centralizes the
 * ladder:
 *
 *   explicit caller value ('private' | 'world')  — always wins
 *     → config key `facts.default_visibility`     — operator-set brain default
 *       → 'private'                               — fail-closed floor
 *
 * Security note (stated intent, per the eng review): setting
 * `facts.default_visibility = world` widens what remote/MCP callers can read
 * back through the hot-memory meta hook and turn_context — that is the
 * DELIBERATE single-principal posture bootstrap configures (CX-P1.1), not a
 * leak. Invalid or unreadable config always resolves 'private'.
 */

import type { BrainEngine } from '../engine.ts';

export type FactVisibility = 'private' | 'world';

export const FACTS_DEFAULT_VISIBILITY_KEY = 'facts.default_visibility';

/**
 * Resolve the brain-level default visibility for facts writes when the caller
 * did not specify one. Reads `facts.default_visibility` via engine.getConfig
 * (the extract.ts:isFactsExtractionEnabled precedent). Returns 'world' only on
 * an explicit, well-formed opt-in; anything else — unset, invalid, or a config
 * read failure — fails closed to 'private'.
 */
export async function resolveDefaultVisibility(engine: BrainEngine): Promise<FactVisibility> {
  try {
    const val = await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    if (val == null) return 'private';
    return val.trim().toLowerCase() === 'world' ? 'world' : 'private';
  } catch {
    return 'private'; // config read failure must never widen visibility
  }
}

/**
 * Op-layer param resolution shared by extract_facts and ontology_propose.
 * Contract (the :4468-ternary fix):
 *   - explicit 'world'  → 'world'  (caller wins)
 *   - explicit 'private'→ 'private' (caller wins — even over a world default)
 *   - unset (null/undefined) → resolveDefaultVisibility(engine)
 *   - any other garbage value → 'private' (fail-closed, matches the historic
 *     coercion for invalid input; only genuinely-unset reaches the config).
 */
export async function resolveVisibilityParam(
  engine: BrainEngine,
  value: unknown,
): Promise<FactVisibility> {
  if (value === 'world') return 'world';
  if (value === 'private') return 'private';
  if (value == null) return resolveDefaultVisibility(engine);
  return 'private';
}

/**
 * Resolve a source-scoped facts visibility.
 *
 * NOTE: this NARROWS the upstream ENG-8 contract documented at the top of this
 * module, which states that an explicit caller value always wins. Here it does
 * not. An explicit `world` against a NON-FEDERATED source is overridden to
 * `private`, and so is any explicit value when the source cannot be resolved.
 * The earlier version of this docstring claimed the upstream ladder and was
 * wrong about its own code; that is corrected here.
 *
 * The actual ladder:
 *
 *   explicit 'private'                  → 'private'
 *   explicit 'world', federated source  → 'world'
 *   explicit 'world', NON-federated     → 'private'   (override, warned once)
 *   unset, source policy 'private'      → 'private'
 *   unset, source policy 'world'        → federated ? 'world' : 'private'
 *   unset, no source policy             → brain default
 *   source missing, or lookup threw     → 'private'   (override, warned once)
 *
 * Why the override is kept rather than honoured: `facts/meta-hook.ts` filters
 * facts for remote callers on the visibility label ALONE, with no independent
 * `source.federated` check at that layer. Honouring an explicit `world` here
 * would therefore write a remote-visible label onto a source the operator never
 * federated. The durable fix is to validate at the CLI/MCP boundary and have
 * the export path check both the label and `source.federated`; until then this
 * function is the backstop and it announces itself.
 */
// G2 ruling (LGV, 2026-09-03): the clamp stays as a fail-closed backstop, but
// it must never be silent. A downgrade of an EXPLICIT caller value is said
// once per (source, reason) per process, mirroring the background-work.ts
// warnedOnce idiom. Once, not per write: the corpus import calls this ~248k
// times and a per-write warn would be its own outage.
const clampWarnedOnce = new Set<string>();

function warnVisibilityClamp(
  sourceId: string,
  requested: FactVisibility,
  reason: 'source_not_federated' | 'source_not_found' | 'resolution_failed',
): void {
  const key = `visibility-clamp:${sourceId}:${reason}`;
  if (clampWarnedOnce.has(key)) return;
  clampWarnedOnce.add(key);
  console.error(
    `[facts:visibility] explicit visibility '${requested}' was OVERRIDDEN to 'private' for source '${sourceId}' (${reason}). ` +
    `This is a fork-local narrowing of the upstream ENG-8 contract; see FUSED-ID-LOCAL-PATCHES.md P4. Said once per source+reason per process.`,
  );
}

export async function resolveSourceVisibility(
  engine: BrainEngine,
  sourceId: string,
  requested?: FactVisibility,
): Promise<FactVisibility> {
  try {
    const rows = await engine.listAllSources({ includeArchived: true });
    const source = rows.find((row) => row.id === sourceId);
    if (!source) {
      if (requested) warnVisibilityClamp(sourceId, requested, 'source_not_found');
      return 'private';
    }
    const config = source.config as Record<string, unknown>;
    const federated = config.federated === true;
    const policy = config.facts_visibility;
    if (requested) {
      if (requested === 'world' && !federated) {
        warnVisibilityClamp(sourceId, requested, 'source_not_federated');
        return 'private';
      }
      return requested;
    }
    if (policy === 'private') return 'private';
    if (policy === 'world') return federated ? 'world' : 'private';
    return resolveDefaultVisibility(engine);
  } catch {
    if (requested) warnVisibilityClamp(sourceId, requested, 'resolution_failed');
    return 'private';
  }
}

/** Test seam: the clamp warns once per process, so tests must reset it. */
export function __resetVisibilityClampWarnings(): void {
  clampWarnedOnce.clear();
}
