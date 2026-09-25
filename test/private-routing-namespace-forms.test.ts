import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { enforcePrivateWriteGuard } from '../src/core/ops/context.ts';
import { isPersonishPageWrite } from '../src/core/private-source-routing.ts';
import { isCompanySlug, isPersonSlug, parseSlugNamespaceRewrites } from '../src/core/slug-namespace.ts';

// GF-W48: D1 private routing must treat the legacy singular namespace and the
// upstream plural namespace identically, so the person -> people corpus move
// cannot change a privacy decision. Both forms are derived from the canonical
// mapping, so this table follows the policy instead of restating it.
const [PERSON_MAP, COMPANY_MAP] = parseSlugNamespaceRewrites('person:people,company:companies');
const PERSON_FORMS = [PERSON_MAP.from, PERSON_MAP.to];
const COMPANY_FORMS = [COMPANY_MAP.from, COMPANY_MAP.to];

// A world-federated default source and NO private source: routing is unarmed.
function unarmedEngine(): BrainEngine {
  return {
    getConfig: async () => null,
    executeRaw: async () => [
      { id: 'default', name: 'Default', local_path: null, last_commit: null, last_sync_at: null,
        config: { federated: true, facts_visibility: 'world' }, created_at: new Date() },
    ],
    getPage: async () => null,
  } as unknown as BrainEngine;
}

function localCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as unknown as OperationContext;
}

describe('slug namespace family helpers', () => {
  test('mapping yields both forms of each family', () => {
    expect(PERSON_FORMS).toHaveLength(2);
    expect(COMPANY_FORMS).toHaveLength(2);
    expect(new Set(PERSON_FORMS).size).toBe(2);
    expect(new Set(COMPANY_FORMS).size).toBe(2);
  });

  for (const ns of PERSON_FORMS) {
    test(`isPersonSlug accepts ${ns}/x`, () => {
      expect(isPersonSlug(`${ns}/alice`)).toBe(true);
      expect(isPersonSlug(`${ns}/`)).toBe(true);
      expect(isCompanySlug(`${ns}/alice`)).toBe(false);
    });
  }

  for (const ns of COMPANY_FORMS) {
    test(`isCompanySlug accepts ${ns}/x`, () => {
      expect(isCompanySlug(`${ns}/acme`)).toBe(true);
      expect(isPersonSlug(`${ns}/acme`)).toBe(false);
    });
  }

  test('segment boundary and case are exact', () => {
    for (const slug of ['personal/x', 'peoples/x', 'persons/x', 'people', 'wiki/people/x', 'People/x', 'concepts/x', '']) {
      expect(isPersonSlug(slug)).toBe(false);
    }
    for (const slug of ['companyx/acme', 'company', 'wiki/companies/acme', 'Companies/acme']) {
      expect(isCompanySlug(slug)).toBe(false);
    }
  });
});

describe('D1 private routing is namespace-form agnostic', () => {
  for (const ns of PERSON_FORMS) {
    test(`isPersonishPageWrite: ${ns}/x is person-shaped from the slug alone`, async () => {
      await expect(isPersonishPageWrite(unarmedEngine(), `${ns}/ns-forms-alice`, { type: 'concept' }))
        .resolves.toBe(true);
    });

    test(`enforcePrivateWriteGuard: unarmed routing fails closed for ${ns}/x`, async () => {
      const engine = unarmedEngine();
      await expect(enforcePrivateWriteGuard(localCtx(engine), 'add_timeline_entry', {
        requestedSourceId: 'default',
        slug: `${ns}/ns-forms-alice`,
      }, { type: 'concept', title: 'NS Forms Alice' })).rejects.toThrow(/NOT ARMED/);
    });
  }

  test('control: a non-person slug with the same shape is not person-shaped and passes unarmed', async () => {
    const engine = unarmedEngine();
    await expect(isPersonishPageWrite(engine, 'concepts/ns-forms-alice', { type: 'concept' })).resolves.toBe(false);
    await expect(enforcePrivateWriteGuard(localCtx(engine), 'add_timeline_entry', {
      requestedSourceId: 'default',
      slug: 'concepts/ns-forms-alice',
    }, { type: 'concept', title: 'NS Forms Alice' })).resolves.toMatchObject({ routed: false });
  });

  test('both person forms produce the identical routing decision', async () => {
    const decide = async (slug: string) => {
      try {
        await enforcePrivateWriteGuard(localCtx(unarmedEngine()), 'add_timeline_entry', {
          requestedSourceId: 'default', slug,
        }, { type: 'concept', title: 'NS Forms Alice' });
        return 'allowed';
      } catch (err) {
        return `refused:${/NOT ARMED/.test(String(err))}`;
      }
    };
    const decisions = await Promise.all(PERSON_FORMS.map((ns) => decide(`${ns}/ns-forms-alice`)));
    expect(decisions).toEqual(['refused:true', 'refused:true']);
  });
});
