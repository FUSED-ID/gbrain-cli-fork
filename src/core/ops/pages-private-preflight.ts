import { parseMarkdown } from '../markdown.ts';
import { assertPrivateRoutingArmed, enforcePrivatePageWrite, isAllowlistedCollision, resolvePrivateWriteSource, shouldAssertPrivateRouting } from '../private-source-routing.ts';
import { isPersonSlug } from '../slug-namespace.ts';
import { assertPageWriteThroughReady } from '../write-through.ts';
import { opError, type OperationContext } from './contract.ts';

export async function preflightPutPagePrivateWrite(
  ctx: OperationContext,
  sourceId: string,
  p: { slug?: unknown; content?: unknown },
): Promise<{ sourceId: string; routedFromSourceId: string | null }> {
  if (typeof p.slug !== 'string' || typeof p.content !== 'string') return { sourceId, routedFromSourceId: null };
  if (!(await shouldAssertPrivateRouting(ctx.engine, sourceId))) return { sourceId, routedFromSourceId: null };
  const parsed = parseMarkdown(p.content, p.slug);
  const route = await resolvePrivateWriteSource(ctx.engine, {
    requestedSourceId: sourceId,
    slug: p.slug,
    content: p.content,
    entityType: parsed.type,
    entityName: parsed.title,
  });
  const moved = route.routed && route.sourceId !== sourceId;
  if (moved && route.reason === 'existing_private_page' && sourceId === 'default'
    && isPersonSlug(p.slug) && parsed.type !== 'person' && /\bperson\b/i.test(parsed.title ?? '')
    && !isAllowlistedCollision(sourceId, p.slug)) {
    throw opError(
      'permission_denied',
      `put_page slug '${p.slug}' collides with an existing private identity and cannot be routed implicitly`,
      'Use the private source explicitly or add the exact approved collision to the privacy allowlist.',
    );
  }
  if (route.routed && ctx.remote !== false) {
    throw opError(
      'permission_denied',
      `put_page slug '${p.slug}' is routed to private source '${route.privateSourceId ?? route.sourceId}' and cannot be written by a remote caller`,
      'Ask the brain host to make this private routed write through its trusted local CLI.',
    );
  }
  if (moved && ctx.remote === false) {
    await assertPageWriteThroughReady(ctx.engine, p.slug, route.sourceId);
    await assertPrivateRoutingArmed(ctx.engine);
    if (route.reason !== 'existing_private_page') {
      await enforcePrivatePageWrite(ctx.engine, {
        requestedSourceId: sourceId,
        slug: p.slug,
        entityType: parsed.type,
        entityName: parsed.title,
      });
    }
  }
  if (!moved) await enforcePrivatePageWrite(ctx.engine, {
    requestedSourceId: sourceId,
    slug: p.slug,
    entityType: parsed.type,
    entityName: parsed.title,
  });
  return { sourceId: route.sourceId, routedFromSourceId: moved ? sourceId : null };
}
