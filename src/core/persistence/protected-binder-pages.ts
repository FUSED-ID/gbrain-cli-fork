/**
 * LGV ruling 2026-11-24: the worker refuses body, fact and atom writes to
 * protected Binder pages and records the skip code `protected_binder_page`
 * (the job completes, it does not fail). Embedding is allowed and is not
 * guarded here.
 *
 * Patterns. The default Binder family (any directory prefix, and the
 * `<source>:<slug>` form) is ALWAYS protected. GBRAIN_PROTECTED_SLUG_PATTERNS
 * (comma list of globs, case-insensitive, `*` any run of characters including
 * slashes, `?` one character) ADDS patterns; it can never remove the default.
 * The only way to disable the guard is GBRAIN_PROTECTED_BINDER_GUARD=off
 * (exact value, case-insensitive). The worker logs the active patterns once at
 * start (logProtectedBinderGuard).
 *
 * Operator override. A maintenance request whose intent carries
 * `protected_page_override: { operator, reason }` (build it with
 * withProtectedPageOverride) is admitted and applied on a protected page, and
 * the admission logs that it did. Nothing sets it by default.
 *
 * Known unguarded paths (coordinator ruling 2026-11-24, documented, no code):
 * - persistence/effect-links.ts (~:107) writes mention edges derived from the
 *   page text. That changes the graph, not the page, so it stays unguarded.
 * - cycle/fence-repair.ts and cycle/content-repair.ts publish repairs outside
 *   the drainer's job allow-list. Their managed writes pass the maintenance
 *   coordinator guard; their legacy confined writes do not.
 * - Widening GBRAIN_WORKER_ONLY_NAMES beyond chronicle_extract, facts-absorb,
 *   embed-backfill and extract-atoms-drain reopens whichever of these paths
 *   the added jobs reach. Re-audit before widening it.
 */
export const PROTECTED_BINDER_SKIP = 'protected_binder_page' as const;
export const PROTECTED_SLUG_PATTERNS_ENV = 'GBRAIN_PROTECTED_SLUG_PATTERNS';
export const PROTECTED_BINDER_GUARD_ENV = 'GBRAIN_PROTECTED_BINDER_GUARD';
export const PROTECTED_PAGE_OVERRIDE_KEY = 'protected_page_override';
export const DEFAULT_PROTECTED_SLUG_PATTERNS: readonly string[] = [
  'binder-gbrain-conops-doc-family-*',
  '*/binder-gbrain-conops-doc-family-*',
];

/** True only when the operator set the explicit off switch. */
export function protectedBinderGuardOff(raw = process.env[PROTECTED_BINDER_GUARD_ENV]): boolean {
  return (raw ?? '').trim().toLowerCase() === 'off';
}

/** Active patterns: the default plus any configured additions; empty only when the guard is off. */
export function protectedSlugPatterns(raw = process.env[PROTECTED_SLUG_PATTERNS_ENV]): string[] {
  if (protectedBinderGuardOff()) return [];
  const added = (raw ?? '').split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_PROTECTED_SLUG_PATTERNS, ...added])];
}

function globRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/** `<source>:<slug>` names the same page as `<slug>`. */
function slugForms(slug: string): string[] {
  const bare = slug.replace(/^[^/:]+:/, '');
  return bare === slug ? [slug] : [slug, bare];
}

/** The one predicate every guarded writer asks. */
export function isProtectedBinderPage(slug: string, patterns = protectedSlugPatterns()): boolean {
  if (!patterns.length) return false;
  const regexes = patterns.map(globRegExp);
  return slugForms(slug).some(form => regexes.some(r => r.test(form)));
}

/** The same patterns as ILIKE operands (backslash is Postgres's default LIKE escape), plus their `<source>:` forms. */
export function protectedSlugLikePatterns(patterns = protectedSlugPatterns()): string[] {
  const like = patterns.map(p => p.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%').replace(/\?/g, '_'));
  return [...like, ...like.map(p => `%:${p}`)];
}

/** SQL clause that leaves protected pages out of a page scan; binds the patterns at `$index`. */
export function protectedSlugExclusionSql(column: string, index: number): string {
  return `AND NOT (${column} ILIKE ANY($${index}::text[]))`;
}

let logged = false;
/** One startup line naming the active guard state. `log` is injectable for tests. */
export function logProtectedBinderGuard(log: (line: string) => void = line => console.error(line)): string {
  const line = protectedBinderGuardOff()
    ? `[binder-guard] OFF (${PROTECTED_BINDER_GUARD_ENV}=off): protected Binder pages are NOT guarded`
    : `[binder-guard] on: ${protectedSlugPatterns().join(', ')}`;
  if (!logged) { logged = true; log(line); }
  return line;
}

export interface ProtectedPageOverride { operator: string; reason: string }

/** Named per-request operator override for one maintenance request on a protected page. */
export function withProtectedPageOverride<T extends Record<string, unknown>>(intent: T, override: ProtectedPageOverride): T {
  if (!override.operator.trim() || !override.reason.trim()) throw new TypeError('A protected-page override names its operator and reason.');
  return { ...intent, [PROTECTED_PAGE_OVERRIDE_KEY]: { operator: override.operator, reason: override.reason } };
}

/** The override a maintenance intent carries, or null. */
export function protectedPageOverride(intent: unknown): ProtectedPageOverride | null {
  const raw = (intent as Record<string, unknown> | null | undefined)?.[PROTECTED_PAGE_OVERRIDE_KEY] as Partial<ProtectedPageOverride> | undefined;
  return raw && typeof raw.operator === 'string' && raw.operator.trim() && typeof raw.reason === 'string' && raw.reason.trim()
    ? { operator: raw.operator, reason: raw.reason } : null;
}
