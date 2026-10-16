import type { BrainEngine } from './engine.ts';
import { assertUnmanagedCanonicalWriter } from './persistence/maintenance.ts';
import { sanitizeText } from './batch-rows.ts';
import type { ParsedMarkdown } from './markdown.ts';
import { resolvePrivateWriteSource } from './private-source-routing.ts';
import { assertPageWriteThroughReady } from './write-through.ts';

export async function routeMarkdownImport(
  engine: BrainEngine,
  prepare: boolean | undefined,
  parsed: ParsedMarkdown,
  content: string,
  slug: string,
  sourceId: string | undefined,
): Promise<{ sourceId: string | undefined; routedFromSourceId: string | null }> {
  if (!prepare) await assertUnmanagedCanonicalWriter(engine, 'direct content import');
  // Canonicalize only free-prose fields before protected-fence parsing, hidden
  // row merging, hashing and indexing. Frontmatter identities stay untouched.
  parsed.title = sanitizeText(parsed.title);
  parsed.compiled_truth = sanitizeText(parsed.compiled_truth);
  parsed.timeline = sanitizeText(parsed.timeline);

  // Route markdown imports through the same private-source policy as put_page.
  // A routed destination must be writable before its canonical row is created.
  const requestedSourceId = sourceId ?? 'default';
  const route = await resolvePrivateWriteSource(engine, {
    requestedSourceId,
    slug,
    content,
    entityType: parsed.type,
    entityName: parsed.title,
  });
  const routedFromSourceId = route.routed && route.sourceId !== requestedSourceId
    ? requestedSourceId
    : null;
  if (route.routed) sourceId = route.sourceId;
  if (routedFromSourceId && sourceId) {
    await assertPageWriteThroughReady(engine, slug, sourceId);
  }
  return { sourceId, routedFromSourceId };
}
