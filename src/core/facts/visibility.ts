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
import { isDerivationPrivate } from '../search/private-visibility.ts';
import { parseSourceConfig } from '../sources-load.ts';

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
    `[facts:visibility] explicit visibility '${requested}' was OVERRIDDEN to 'private' for source '${sourceId}' (${reason}).`,
  );
}

/** Apply the source floor to a stage-one visibility decision. */
export function tightenToSource(
  visibility: FactVisibility,
  source: { exists: boolean; federated: boolean },
): FactVisibility {
  return source.exists && source.federated ? visibility : 'private';
}

/**
 * Resolve source policy after caller precedence, then apply the source floor.
 * A source must exist and carry the literal boolean `federated: true` for a
 * world fact to survive. Policy only fills an unset caller value.
 */
export async function resolveSourceVisibility(
  engine: BrainEngine,
  sourceId: string,
  requested?: unknown,
): Promise<FactVisibility> {
  try {
    const source = (await engine.listAllSources({ includeArchived: true })).find(row => row.id === sourceId);
    if (!source) {
      if (requested === 'world') warnVisibilityClamp(sourceId, 'world', 'source_not_found');
      return 'private';
    }
    const config = parseSourceConfig(source.config);
    const stageOne = requested === 'world' || requested === 'private'
      ? requested
      : requested == null
        ? config.facts_visibility === 'world' || config.facts_visibility === 'private'
          ? config.facts_visibility
          : await resolveDefaultVisibility(engine)
        : 'private';
    const result = tightenToSource(stageOne, { exists: true, federated: config.federated === true });
    if (result === 'private' && stageOne === 'world') {
      warnVisibilityClamp(sourceId, stageOne, 'source_not_federated');
    }
    return result;
  } catch {
    if (requested === 'world') warnVisibilityClamp(sourceId, 'world', 'resolution_failed');
    return 'private';
  }
}

/** Test seam for the once-per-process warning contract. */
export function __resetVisibilityClampWarnings(): void {
  clampWarnedOnce.clear();
}

/**
 * Facts derived from a page never take a broader visibility than that page: a
 * `visibility: private` page, a derived page that reads as private, or a page
 * carrying a privacy marker (`access: private`, a private `confidentiality`)
 * yields private facts whatever the caller or the brain default asked for.
 */
export function tightenToPage(visibility: FactVisibility, page: { type?: string | null; frontmatter?: unknown } | null | undefined): FactVisibility {
  return page && isDerivationPrivate(page) ? 'private' : visibility;
}

/**
 * `remember` without a `visibility`: the v1 default is `world`, except where
 * that would widen what the caller is saving into. A private target page, an
 * operator's explicit private `facts.default_visibility` (any non-empty value
 * other than `world`, as the writeback posture reads it) or an unreadable
 * config resolve `private`.
 */
export async function resolveRememberVisibility(engine: BrainEngine, page: { type?: string | null; frontmatter?: unknown } | null | undefined): Promise<FactVisibility> {
  if (page && isDerivationPrivate(page)) return 'private';
  try {
    const raw = (await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY))?.trim().toLowerCase() ?? '';
    return raw === '' || raw === 'world' ? 'world' : 'private';
  } catch {
    return 'private';
  }
}
