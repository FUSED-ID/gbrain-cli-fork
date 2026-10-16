import { parseMarkdown } from '../markdown.ts';
import { enforcePrivatePageWrite, resolvePrivateWriteSource } from '../private-source-routing.ts';
import { assertPageWriteThroughReady } from '../write-through.ts';
import type { OperationContext } from './contract.ts';

export async function preflightPutPagePrivateWrite(
  ctx: OperationContext,
  sourceId: string,
  p: { slug?: unknown; content?: unknown },
): Promise<void> {
  if (typeof p.slug !== 'string' || typeof p.content !== 'string') return;
  const parsed = parseMarkdown(p.content, p.slug);
  const route = await resolvePrivateWriteSource(ctx.engine, {
    requestedSourceId: sourceId,
    slug: p.slug,
    content: p.content,
    entityType: parsed.type,
    entityName: parsed.title,
  });
  if (route.routed && route.sourceId !== sourceId && ctx.remote === false) {
    await assertPageWriteThroughReady(ctx.engine, p.slug, route.sourceId);
  }
  await enforcePrivatePageWrite(ctx.engine, {
    requestedSourceId: sourceId,
    slug: p.slug,
    entityType: parsed.type,
    entityName: parsed.title,
  });
}
