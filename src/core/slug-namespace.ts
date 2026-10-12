import type { BrainEngine } from './engine.ts';

/** DB-plane config key for opt-in first-segment slug namespace rewrites. */
export const SLUG_NAMESPACE_REWRITES_CONFIG_KEY = 'slug_namespace_rewrites';

/** Environment override for scripted/tested namespace rewrite policy. */
export const GBRAIN_SLUG_NAMESPACE_REWRITES_ENV = 'GBRAIN_SLUG_NAMESPACE_REWRITES';

export interface SlugNamespaceRewrite {
  from: string;
  to: string;
}

export interface SlugNamespaceLogger {
  warn(message: string): void;
}

interface CachedSlugNamespaceRewrites {
  at: number;
  rules: SlugNamespaceRewrite[];
}

const SLUG_NAMESPACE_REWRITES_CACHE_TTL_MS = 30_000;
const slugNamespaceRewritesCache = new WeakMap<object, CachedSlugNamespaceRewrites>();

/** Parse `from:to,from2:to2` policy values. */
export function parseSlugNamespaceRewrites(raw: string | null | undefined): SlugNamespaceRewrite[] {
  if (!raw) return [];
  const out: SlugNamespaceRewrite[] = [];
  for (const entry of raw.split(',')) {
    const [from, to, ...extra] = entry.split(':').map((part) => part.trim());
    if (!from || !to || extra.length > 0 || from.includes('/') || to.includes('/')) continue;
    out.push({ from, to });
  }
  return out;
}

/**
 * Resolve the active policy. The env spelling is an explicit operator/test
 * override; otherwise the normal DB-plane config is consulted. Missing config
 * and test doubles without getConfig both mean OFF.
 */
export async function resolveSlugNamespaceRewrites(
  engine: BrainEngine,
  logger?: SlugNamespaceLogger,
): Promise<SlugNamespaceRewrite[]> {
  const envValue = process.env[GBRAIN_SLUG_NAMESPACE_REWRITES_ENV];
  if (envValue !== undefined) return parseSlugNamespaceRewrites(envValue);

  const getConfig = (engine as Partial<BrainEngine>).getConfig;
  if (typeof getConfig !== 'function') return [];

  const now = Date.now();
  const cached = slugNamespaceRewritesCache.get(engine);
  if (cached && now - cached.at < SLUG_NAMESPACE_REWRITES_CACHE_TTL_MS) return cached.rules;

  try {
    const rules = parseSlugNamespaceRewrites(await getConfig.call(engine, SLUG_NAMESPACE_REWRITES_CONFIG_KEY));
    slugNamespaceRewritesCache.set(engine, { at: Date.now(), rules });
    return rules;
  } catch {
    const rules: SlugNamespaceRewrite[] = [];
    slugNamespaceRewritesCache.set(engine, { at: Date.now(), rules });
    (logger?.warn ?? ((message: string) => console.warn(message)))
      ('[slug-namespace] config read failed; namespace rewrites disabled for this engine');
    return rules;
  }
}

/** Apply one configured mapping to the first slug segment only. */
export function normalizePageWriteSlug(
  slug: string,
  rewrites: readonly SlugNamespaceRewrite[] = [],
): string {
  if (slug.endsWith('/_author')) return slug;
  const firstSlash = slug.indexOf('/');
  const first = firstSlash === -1 ? slug : slug.slice(0, firstSlash);
  const rewrite = rewrites.find((candidate) => candidate.from === first);
  if (!rewrite) return slug;
  return firstSlash === -1 ? rewrite.to : `${rewrite.to}${slug.slice(firstSlash)}`;
}

/** Apply the active policy to a page slug. */
export async function normalizePageWriteSlugWithConfig(
  engine: BrainEngine,
  slug: string,
  logger?: SlugNamespaceLogger,
): Promise<string> {
  return normalizePageWriteSlug(slug, await resolveSlugNamespaceRewrites(engine, logger));
}

/**
 * Entity namespace families. Each family lists the legacy singular first
 * segment and the upstream plural first segment. Privacy, routing and filing
 * checks must accept both, so a corpus move between the two forms can never
 * change a policy decision.
 */
const PERSON_SLUG_NAMESPACES: ReadonlySet<string> = new Set(['person', 'people']);
const COMPANY_SLUG_NAMESPACES: ReadonlySet<string> = new Set(['company', 'companies']);

function slugHasNamespace(slug: string, namespaces: ReadonlySet<string>): boolean {
  const firstSlash = slug.indexOf('/');
  if (firstSlash === -1) return false;
  return namespaces.has(slug.slice(0, firstSlash));
}

/** True when the first slug segment is a person namespace (either form). */
export function isPersonSlug(slug: string): boolean {
  return slugHasNamespace(slug, PERSON_SLUG_NAMESPACES);
}

/** True when the first slug segment is a company namespace (either form). */
export function isCompanySlug(slug: string): boolean {
  return slugHasNamespace(slug, COMPANY_SLUG_NAMESPACES);
}
