import type { BrainEngine } from '../engine.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';

/** Legacy key export retained for callers; publication now uses canonical page guards. */
export function autoLinkLockKey(sourceId: string | undefined, slug: string): string {
  return `auto_link:${sourceId ?? ''}:${slug}`;
}

/** Revisit forward references after a oneshot batch, conditional on its current snapshot. */
export async function autoLinkWrittenPage(
  engine: BrainEngine,
  slug: string,
  opts?: { sourceId?: string },
): Promise<void> {
  try {
    if (!(await isAutoLinkEnabled(engine))) return;
    await runAutoLink(engine, slug, opts);
  } catch (e) {
    process.stderr.write(`[oneshot] post-batch auto-link for ${slug} failed (best-effort): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Reconcile derived links only if the prepared canonical snapshot is still current. */
async function runAutoLink(
  engine: BrainEngine,
  slug: string,
  opts?: { sourceId?: string },
) {
  const sourceId = opts?.sourceId ?? 'default';
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return;
  const { prepareAutomaticLinks } = await import('../persistence/links-preparation.ts');
  const prepared = await prepareAutomaticLinks(engine, slug, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, sourceId);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{sourceId,slug}, ...prepared.pageKeys]);
    const current = await tx.readPageSnapshot(slug, {sourceId});
    if (!current || current.page.id !== snapshot.page.id || current.revision !== snapshot.revision) return;
    return prepared.apply(tx);
  });
}
