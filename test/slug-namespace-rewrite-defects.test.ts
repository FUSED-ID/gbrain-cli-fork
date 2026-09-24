import { describe, expect, test } from 'bun:test';
import { MAX_FILE_SIZE } from '../src/core/import-file.ts';
import { resolveEntitySlug } from '../src/core/entities/resolve.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext, Operation } from '../src/core/ops/contract.ts';
import {
  resolveSlugNamespaceRewrites,
  normalizePageWriteSlugWithConfig,
} from '../src/core/slug-namespace.ts';
import { withEnv } from './helpers/with-env.ts';

const put_page = operations.find((op) => op.name === 'put_page') as Operation;
const get_page = operations.find((op) => op.name === 'get_page') as Operation;
if (!put_page || !get_page) throw new Error('page operations missing');

function makeCtx(engine: BrainEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    deferEmbeds: true,
    ...overrides,
  };
}

function throwingConfigEngine(): BrainEngine {
  let engine: BrainEngine;
  engine = new Proxy({ kind: 'pglite' } as any, {
    get(_target, property: string) {
      if (property === 'kind') return 'pglite';
      if (property === 'getConfig') return async (key: string) => {
        if (key === 'slug_namespace_rewrites') throw new Error('synthetic config outage');
        return null;
      };
      if (property === 'executeRaw') return async () => [];
      if (property === 'getPage') return async (slug: string) => ({
        id: 1,
        slug,
        type: 'note',
        title: 'Config outage probe',
        compiled_truth: 'stub',
        timeline: '',
        frontmatter: {},
        source_id: 'default',
        created_at: new Date(),
        updated_at: new Date(),
        content_hash: 'stub',
        deleted_at: null,
      });
      if (property === 'getTags') return async () => [];
      if (property === 'listAllSources') return async () => [];
      if (property === 'resolveSlugWithAliasDetailed') return async () => null;
      if (property === 'resolveAliases') return async () => new Map();
      if (property === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine);
      return async () => null;
    },
  }) as BrainEngine;
  return engine;
}

describe('opt-in slug namespace rewrite defects', () => {
  test('fenced client rejects the rewritten slug outside its fence', async () => {
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'people:person' }, async () => {
      const ctx = makeCtx({} as BrainEngine, {
        dryRun: true,
        engine: {} as BrainEngine,
        auth: {
          token: 'test-token',
          clientId: 'fenced-client',
          scopes: ['write'],
          sourceId: 'default',
          boundSlugPrefixes: ['people/'],
        },
      });
      await expect(put_page.handler(ctx, { slug: 'people/x', content: 'stub' }))
        .rejects.toMatchObject({ code: 'permission_denied' });
      try {
        await put_page.handler(ctx, { slug: 'people/x', content: 'stub' });
      } catch (error) {
        expect(error).toBeInstanceOf(OperationError);
        expect((error as Error).message).toContain('person/x');
      }
    });
  });

  test('config failure leaves put_page and get_page operational with rewrites off', async () => {
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
      const engine = throwingConfigEngine();
      const warnings: string[] = [];
      const ctx = makeCtx(engine, { logger: { info: () => {}, warn: (message: string) => warnings.push(message), error: () => {} } });

      const putResult = await put_page.handler(ctx, {
        slug: 'notes/config-outage',
        content: 'x'.repeat(MAX_FILE_SIZE + 1),
      }) as Record<string, unknown>;
      expect(putResult).toMatchObject({ slug: 'notes/config-outage', status: 'skipped' });

      const getResult = await get_page.handler(ctx, { slug: 'notes/config-outage' }) as Record<string, unknown>;
      expect(getResult).toMatchObject({ slug: 'notes/config-outage', title: 'Config outage probe' });
      expect(warnings).toHaveLength(1);
    });
  });

  test('two consecutive namespace resolves share one config read within the TTL', async () => {
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
      let calls = 0;
      const engine = {
        kind: 'pglite',
        getConfig: async () => { calls++; return 'people:person'; },
      } as unknown as BrainEngine;

      expect(await resolveSlugNamespaceRewrites(engine)).toEqual([{ from: 'people', to: 'person' }]);
      expect(await normalizePageWriteSlugWithConfig(engine, 'people/alice')).toBe('person/alice');
      expect(calls).toBe(1);
    });
  });

  test('entity resolution remains fail-off when the config read throws', async () => {
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
      const engine = throwingConfigEngine();
      const result = await resolveEntitySlug(engine, 'default', 'Alice Example');
      expect(result).toBe('alice-example');
    });
  });
});
