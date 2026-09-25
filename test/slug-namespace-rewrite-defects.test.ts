import { describe, expect, test } from 'bun:test';
import { MAX_FILE_SIZE } from '../src/core/import-file.ts';
import { resolveEntitySlug } from '../src/core/entities/resolve.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext, Operation } from '../src/core/ops/contract.ts';
import {
  resolveSlugNamespaceRewrites,
  normalizePageWriteSlugWithConfig,
  parseSlugNamespaceRewrites,
} from '../src/core/slug-namespace.ts';
import { withEnv } from './helpers/with-env.ts';

// GF-W52: the fence case binds a client to the legacy singular prefix on
// purpose. The singular segment comes from the canonical mapping.
const LEGACY_PERSON = parseSlugNamespaceRewrites('person:people')[0].from;

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
      if (property === 'readPageSnapshot') return async (slug: string) => ({
        page: {
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
        },
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
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: 'person:people,company:companies' }, async () => {
      const ctx = makeCtx({} as BrainEngine, {
        dryRun: true,
        engine: {} as BrainEngine,
        auth: {
          token: 'test-token',
          clientId: 'fenced-client',
          scopes: ['write'],
          sourceId: 'default',
          boundSlugPrefixes: [`${LEGACY_PERSON}/`],
        },
      });
      await expect(put_page.handler(ctx, { slug: `${LEGACY_PERSON}/x`, content: 'stub' }))
        .rejects.toMatchObject({ code: 'permission_denied' });
      try {
        await put_page.handler(ctx, { slug: `${LEGACY_PERSON}/x`, content: 'stub' });
      } catch (error) {
        expect(error).toBeInstanceOf(OperationError);
        expect((error as Error).message).toContain('people/x');
      }
    });
  });

  test('config failure leaves put_page and get_page operational with rewrites off', async () => {
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
      // v0.57 put_page publishes through the persistence pipeline, which a
      // stub engine cannot host. Use a real PGLite brain whose slug-rewrite
      // config read throws; every other config key reads normally.
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      const realGetConfig = engine.getConfig.bind(engine);
      (engine as unknown as { getConfig: (key: string) => Promise<string | null> }).getConfig = async (key: string) => {
        if (key === 'slug_namespace_rewrites') throw new Error('synthetic config outage');
        return realGetConfig(key);
      };
      try {
        const warnings: string[] = [];
        const ctx = makeCtx(engine, {
          remote: false,
          logger: { info: () => {}, warn: (message: string) => warnings.push(message), error: () => {} },
        });

        const putResult = await put_page.handler(ctx, {
          slug: 'notes/config-outage',
          content: '---\ntype: note\ntitle: Config outage probe\n---\n\nConfig outage probe body.\n',
        }) as Record<string, unknown>;
        expect(putResult).toMatchObject({ slug: 'notes/config-outage' });

        const getResult = await get_page.handler(ctx, { slug: 'notes/config-outage' }) as Record<string, unknown>;
        expect(getResult).toMatchObject({ slug: 'notes/config-outage', title: 'Config outage probe' });
        expect(warnings).toHaveLength(1);
      } finally {
        await engine.disconnect();
      }
    });
  }, 120_000);

  test('two consecutive namespace resolves share one config read within the TTL', async () => {
    await withEnv({ GBRAIN_SLUG_NAMESPACE_REWRITES: undefined }, async () => {
      let calls = 0;
      const engine = {
        kind: 'pglite',
        getConfig: async () => { calls++; return 'person:people,company:companies'; },
      } as unknown as BrainEngine;

      expect(await resolveSlugNamespaceRewrites(engine)).toEqual([
        { from: 'person', to: 'people' },
        { from: 'company', to: 'companies' },
      ]);
      expect(await normalizePageWriteSlugWithConfig(engine, 'person/alice')).toBe('people/alice');
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
