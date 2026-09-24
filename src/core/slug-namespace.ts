import type { BrainEngine } from './engine.ts';

/** DB-plane config key for opt-in first-segment slug namespace rewrites. */
export const SLUG_NAMESPACE_REWRITES_CONFIG_KEY = 'slug_namespace_rewrites';

/** Environment override for scripted/tested namespace rewrite policy. */
export const GBRAIN_SLUG_NAMESPACE_REWRITES_ENV = 'GBRAIN_SLUG_NAMESPACE_REWRITES';

export interface SlugNamespaceRewrite {
  from: string;
  to: string;
}

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
export async function resolveSlugNamespaceRewrites(engine: BrainEngine): Promise<SlugNamespaceRewrite[]> {
  const envValue = process.env[GBRAIN_SLUG_NAMESPACE_REWRITES_ENV];
  if (envValue !== undefined) return parseSlugNamespaceRewrites(envValue);

  const getConfig = (engine as Partial<BrainEngine>).getConfig;
  if (typeof getConfig !== 'function') return [];
  return parseSlugNamespaceRewrites(await getConfig.call(engine, SLUG_NAMESPACE_REWRITES_CONFIG_KEY));
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
): Promise<string> {
  return normalizePageWriteSlug(slug, await resolveSlugNamespaceRewrites(engine));
}
