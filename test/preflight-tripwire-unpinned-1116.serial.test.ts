/**
 * PREFLIGHT-TRIPWIRE-UNPINNED (2026-11-16): the explicit route check in
 * src/core/ops/pages-private-preflight.ts. A local put_page that the route moves to a source
 * other than the private source it names, or other than the armed private source, is refused
 * with permission_denied before anything is written. The routing module and the write-through
 * readiness check are stubbed, so the check is exercised alone: with it replaced by
 * `if (false)` the refusal cases fail and the control still passes; with only its second
 * half kept (route.sourceId !== armed.privateSourceId) the third case fails.
 * Serial (R2): the top-level mock.module replaces these modules for every later file in
 * the same Bun process, so the file runs in its own process (scripts/serial-files.tsv).
 */
import { describe, expect, mock, test } from 'bun:test';
import * as realRouting from '../src/core/private-source-routing.ts';
import * as realWriteThrough from '../src/core/write-through.ts';

let route: realRouting.PrivateWriteRoute = { sourceId: 'default', routed: false };
let armedPrivate = 'lg-private';
const enforced: string[] = [];

mock.module('../src/core/private-source-routing.ts', () => ({
  ...realRouting,
  shouldAssertPrivateRouting: async () => true,
  resolvePrivateWriteSource: async () => route,
  assertPrivateRoutingArmed: async () => ({ privateSourceId: armedPrivate, localPath: '/nonexistent', excludedEntryCount: 0 }),
  enforcePrivatePageWrite: async (_engine: unknown, input: { slug: string }) => { enforced.push(input.slug); },
  isAllowlistedCollision: () => false,
}));
mock.module('../src/core/write-through.ts', () => ({
  ...realWriteThrough,
  assertPageWriteThroughReady: async () => {},
}));

const { preflightPutPagePrivateWrite } = await import('../src/core/ops/pages-private-preflight.ts');

const local = { engine: {} as never, remote: false } as never;
const page = { slug: 'people/tripwire-example', content: '---\ntype: person\ntitle: Tripwire Example\n---\n# Tripwire Example\n' };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return String((e as { code?: unknown }).code);
  }
}

describe('preflight explicit route check (stubbed route)', () => {
  test('a moved route whose sourceId differs from the private source it names is refused', async () => {
    route = { sourceId: 'rogue-source', routed: true, reason: 'excluded_people_policy', privateSourceId: 'lg-private' };
    armedPrivate = 'lg-private';
    expect(await codeOf(preflightPutPagePrivateWrite(local, 'default', page))).toBe('permission_denied');
  });

  test('a moved route to a named private source that is not the armed private source is refused', async () => {
    route = { sourceId: 'lg-private', routed: true, reason: 'excluded_people_policy', privateSourceId: 'lg-private' };
    armedPrivate = 'other-private';
    expect(await codeOf(preflightPutPagePrivateWrite(local, 'default', page))).toBe('permission_denied');
  });

  test('a moved route to the armed private source that names a different private source is refused', async () => {
    route = { sourceId: 'lg-private', routed: true, reason: 'excluded_people_policy', privateSourceId: 'other' };
    armedPrivate = 'lg-private';
    expect(await codeOf(preflightPutPagePrivateWrite(local, 'default', page))).toBe('permission_denied');
  });

  test('control: a moved route to the armed private source it names passes and reports the move', async () => {
    route = { sourceId: 'lg-private', routed: true, reason: 'excluded_people_policy', privateSourceId: 'lg-private' };
    armedPrivate = 'lg-private';
    expect(await preflightPutPagePrivateWrite(local, 'default', page)).toEqual({ sourceId: 'lg-private', routedFromSourceId: 'default' });
    expect(enforced).toEqual([]);
  });
});
