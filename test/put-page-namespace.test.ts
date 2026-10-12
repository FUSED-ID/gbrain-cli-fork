/**
 * Regression + namespace tests for put_page (v0.16.0 Lane 1D).
 *
 * The namespace rule confines subagent-originated writes to
 * `wiki/agents/<subagentId>/...`. This test pins:
 *  - regression: local CLI and standard MCP paths (ctx.viaSubagent != true)
 *    continue to accept ANY slug — the rule is opt-in by the dispatcher.
 *  - namespace: anchored prefix, slash boundary, wrong id, leading-slash fail,
 *    prefix-collision defeated, and fail-closed when subagentId is missing.
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveEntitySlug } from '../src/core/entities/resolve.ts';
import { parseSlugNamespaceRewrites } from '../src/core/slug-namespace.ts';
import { withEnv } from './helpers/with-env.ts';

// GF-W52: these cases feed the legacy singular form to the rewrite guard on
// purpose. The singular segments come from the canonical mapping.
const [PERSON_MAP, COMPANY_MAP] = parseSlugNamespaceRewrites('person:people,company:companies');
const LEGACY_PERSON = PERSON_MAP.from;
const LEGACY_COMPANY = COMPANY_MAP.from;

const put_page = operations.find(o => o.name === 'put_page') as Operation;
const get_page = operations.find(o => o.name === 'get_page') as Operation;
if (!put_page) throw new Error('put_page op missing');
if (!get_page) throw new Error('get_page op missing');

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('put_page namespace (v0.15 subagent rule)', () => {
  describe('regression: non-subagent callers unchanged', () => {
    test('local CLI write (viaSubagent undefined) accepts arbitrary slug', async () => {
      const ctx = makeCtx({ remote: false });
      const result = await put_page.handler(ctx, { slug: 'people/alice', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'people/alice' });
    });

    test('MCP write (remote=true, viaSubagent=undefined) accepts arbitrary slug', async () => {
      const ctx = makeCtx({ remote: true });
      const result = await put_page.handler(ctx, { slug: 'wiki/analysis/foo', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'wiki/analysis/foo' });
    });

    test('viaSubagent=false is the same as unset', async () => {
      const ctx = makeCtx({ remote: true, viaSubagent: false, subagentId: 42 });
      const result = await put_page.handler(ctx, { slug: 'anything/goes', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true });
    });
  });

  describe('entity namespace normalization (opt-in)', () => {
    test('leaves people unchanged when the rewrite flag is off', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: 'people/zz-probe', content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'people/zz-probe' });
      });
    });

    test('rewrites a first-segment person slug to people when enabled', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: `${LEGACY_PERSON}/zz-probe`, content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'people/zz-probe' });
      });
    });

    test('rewrites a first-segment company slug to companies when enabled', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: `${LEGACY_COMPANY}/acme`, content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'companies/acme' });
      });
    });

    test('leaves person namespace unchanged', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: `${LEGACY_PERSON}/x`, content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, slug: `${LEGACY_PERSON}/x` });
      });
    });

    test('leaves people in a later segment unchanged', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: 'wiki/people-notes', content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, slug: 'wiki/people-notes' });
      });
    });

    test('leaves people in a deeper segment unchanged', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: 'a/people/b', content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, slug: 'a/people/b' });
      });
    });

    test('leaves _author slugs unchanged', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
        const ctx = makeCtx();
        const result = await put_page.handler(ctx, { slug: 'people/alice/_author', content: 'stub' });
        expect(result).toMatchObject({ dry_run: true, slug: 'people/alice/_author' });
      });
    });

    test('enabled write and exact get_page/entity reads use people namespace', async () => {
      await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
        let readSlug = '';
        const page = {
          id: 7, slug: 'people/zz-probe', type: 'person', title: 'ZZ Probe',
          compiled_truth: 'stub', timeline: '', frontmatter: {}, source_id: 'default',
          created_at: new Date(), updated_at: new Date(), content_hash: 'stub', deleted_at: null,
        };
        const engine = {
          getConfig: async () => null,
          getPage: async (slug: string) => { readSlug = slug; return page; },
          getTags: async () => [],
          executeRaw: async (_sql: string, params: unknown[]) =>
            params[1] === 'people/zz-probe' ? [{ slug: 'people/zz-probe' }] : [],
        } as unknown as BrainEngine;
        const result = await get_page.handler(makeCtx({ engine, dryRun: false, remote: false }), {
          slug: `${LEGACY_PERSON}/zz-probe`,
        }) as Record<string, unknown>;
        expect(readSlug).toBe('people/zz-probe');
        expect(result.slug).toBe('people/zz-probe');
        expect(result.resolved_slug).toBe('people/zz-probe');
        expect(await resolveEntitySlug(engine, 'default', `${LEGACY_PERSON}/zz-probe`)).toBe('people/zz-probe');
      });
    });
  });

  describe('subagent namespace rule', () => {
    test('accepts wiki/agents/<subagentId>/ prefix', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const result = await put_page.handler(ctx, { slug: 'wiki/agents/42/notes', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true, slug: 'wiki/agents/42/notes' });
    });

    test('accepts deep paths under the prefix', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const result = await put_page.handler(ctx, { slug: 'wiki/agents/42/runs/2026-04-20/summary', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('rejects leading slash (slug grammar + anchor)', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const p = put_page.handler(ctx, { slug: '/wiki/agents/42/foo', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('rejects wrong subagentId', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const p = put_page.handler(ctx, { slug: 'wiki/agents/12/foo', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('rejects prefix-collision attempt (wiki/agents/12evil/* with subagentId=12)', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 12 });
      const p = put_page.handler(ctx, { slug: 'wiki/agents/12evil/foo', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('rejects bare prefix with no suffix (slug.length === prefix.length)', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const p = put_page.handler(ctx, { slug: 'wiki/agents/42/', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('FAIL-CLOSED: viaSubagent=true with undefined subagentId rejects any slug', async () => {
      const ctx = makeCtx({ viaSubagent: true });
      const p = put_page.handler(ctx, { slug: 'wiki/agents/42/foo', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/subagentId/);
    });

    test('FAIL-CLOSED: viaSubagent=true with NaN subagentId rejects', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: Number.NaN });
      const p = put_page.handler(ctx, { slug: 'wiki/agents/NaN/foo', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('error code is permission_denied (not validation)', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      try {
        await put_page.handler(ctx, { slug: 'people/alice', content: 'stub' });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OperationError);
        expect((e as OperationError).code).toBe('permission_denied');
      }
    });
  });
});
