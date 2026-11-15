import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveRememberVisibility, tightenToPage } from '../src/core/facts/visibility.ts';

function visibilityEngine(value: string | null, failure = false) {
  return {
    async getConfig() {
      if (failure) throw new Error('source policy unavailable');
      return value;
    },
  } as any;
}

let realEngine: PGLiteEngine;

beforeAll(async () => {
  realEngine = new PGLiteEngine();
  await realEngine.connect({});
  await realEngine.initSchema();
});

afterAll(async () => {
  await realEngine.disconnect();
});

describe('P4 source visibility floor cases moved from D1', () => {
  test('normalizes facts so world visibility never lands in a non-federated source', async () => {
    const defaultEngine = visibilityEngine('world');
    const privateEngine = visibilityEngine('private');
    const missingEngine = visibilityEngine(null, true);
    const privatePage = { type: 'note', frontmatter: { visibility: 'private' } };

    expect(tightenToPage('world', privatePage)).toBe('private');
    await expect(resolveRememberVisibility(defaultEngine, { type: 'note', frontmatter: {} })).resolves.toBe('world');
    await expect(resolveRememberVisibility(privateEngine, { type: 'note', frontmatter: {} })).resolves.toBe('private');
    await expect(resolveRememberVisibility(missingEngine, { type: 'note', frontmatter: {} })).resolves.toBe('private');
  });

  test('clamps a world fact to private when the source policy is private', async () => {
    await realEngine.updateSourceConfig('default', { federated: false, facts_visibility: 'private' });
    const privateInserted = await realEngine.insertFact(
      { fact: 'must stay private', entity_slug: 'notes/ordinary', visibility: 'world', source: 'test' },
      { source_id: 'default' },
    );
    const privateRows = await realEngine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id = $1', [privateInserted.id]);
    expect(privateRows[0]?.visibility).toBe('private');
  });
});
