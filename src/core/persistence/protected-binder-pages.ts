/**
 * LGV ruling 2026-11-24: the worker refuses body, fact and atom writes to
 * protected Binder pages and records the skip code `protected_binder_page`
 * (the job completes, it does not fail). Embedding is allowed and is not
 * guarded here.
 *
 * GBRAIN_PROTECTED_SLUG_PATTERNS is a comma list of glob patterns matched
 * against the whole slug, case-insensitive (`*` any run of characters,
 * slashes included; `?` one character). Unset or blank keeps the default
 * Binder family at any directory prefix, so a stray empty value cannot open
 * the guard; to turn it off, set a pattern that matches nothing.
 */
export const PROTECTED_BINDER_SKIP = 'protected_binder_page' as const;
export const PROTECTED_SLUG_PATTERNS_ENV = 'GBRAIN_PROTECTED_SLUG_PATTERNS';
export const DEFAULT_PROTECTED_SLUG_PATTERNS: readonly string[] = [
  'binder-gbrain-conops-doc-family-*',
  '*/binder-gbrain-conops-doc-family-*',
];

export function protectedSlugPatterns(raw = process.env[PROTECTED_SLUG_PATTERNS_ENV]): string[] {
  const parsed = (raw ?? '').split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_PROTECTED_SLUG_PATTERNS];
}

function globRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/** The one predicate every guarded writer asks. */
export function isProtectedBinderPage(slug: string, patterns = protectedSlugPatterns()): boolean {
  return patterns.some(p => globRegExp(p).test(slug));
}

/** The same patterns as ILIKE operands (backslash is Postgres's default LIKE escape). */
export function protectedSlugLikePatterns(patterns = protectedSlugPatterns()): string[] {
  return patterns.map(p => p.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%').replace(/\?/g, '_'));
}

/** SQL clause that leaves protected pages out of a page scan; binds the patterns at `$index`. */
export function protectedSlugExclusionSql(column: string, index: number): string {
  return `AND NOT (${column} ILIKE ANY($${index}::text[]))`;
}
