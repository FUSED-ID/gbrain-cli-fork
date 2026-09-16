/**
 * Defect 1: the T-LEAK-7 collision allowlist exempts only the live private
 * collision from routing, while the ops/pages.ts remote fence remains active.
 *
 * This file exercises the real put_page operation handler (ops/pages.ts),
 * not the engine directly, so it covers exactly the code path that resolves
 * and writes the requested source.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { OperationError } from '../src/core/operations.ts';

const putPage = operations.find((o) => o.name === 'put_page')!;
const ALLOWLIST_PATH_ENV = 'GBRAIN_PRIVACY_ALLOWLIST_PATH';

let engine: PGLiteEngine;
let policyDir: string;
let allowlistDir: string;
let allowlistPath: string;
let savedAllowlistPath: string | undefined;

function writePolicy(): void {
  writeFileSync(join(policyDir, '_brain-filing-rules.md'), '# filing rules\n');
  writeFileSync(
    join(policyDir, '_excluded-people.md'),
    '## Family deny-list\n| Slug pattern | Name |\n|---|---|\n| `unrelated` | Unrelated |\n',
  );
}

async function pointPrivateSource(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ('lg-private', 'LG private', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [policyDir],
  );
  await engine.executeRaw(
    `UPDATE sources
     SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{facts_visibility}', '"world"'::jsonb)
     WHERE id = 'default'`,
  );
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const ALLOWLISTED_SLUG = 'person/lgv-allowlist-fence-test';
const CONTENT = '---\ntype: concept\ntitle: LGV Allowlist Fence Test\n---\n\nAllowlisted stub body.\n';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  if (allowlistDir && existsSync(allowlistDir)) rmSync(allowlistDir, { recursive: true, force: true });
}, 120000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  policyDir = mkdtempSync(join(tmpdir(), 'gbrain-allowlist-fence-policy-'));
  allowlistDir = mkdtempSync(join(tmpdir(), 'gbrain-allowlist-fence-list-'));
  allowlistPath = join(allowlistDir, 'privacy-allowlist.tsv');
  savedAllowlistPath = process.env[ALLOWLIST_PATH_ENV];
  process.env[ALLOWLIST_PATH_ENV] = allowlistPath;
  await pointPrivateSource();
  writePolicy();
  // Seed the private copy so rule (b) has a live private page to match.
  await engine.putPage('lgv-allowlist-fence-test', {
    type: 'concept',
    title: 'LGV Allowlist Fence Test',
    compiled_truth: 'Private copy.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'lg-private' });
});

afterAll(() => {
  if (savedAllowlistPath === undefined) delete process.env[ALLOWLIST_PATH_ENV];
  else process.env[ALLOWLIST_PATH_ENV] = savedAllowlistPath;
});

describe('defect 1: collision allowlist must not weaken routing or the remote fence', () => {
  test('local caller: allowlisted slug still routes to lg-private via put_page (no allowlist row)', async () => {
    const written = await putPage.handler(makeCtx({ remote: false }), {
      slug: ALLOWLISTED_SLUG,
      content: CONTENT,
    }) as { slug: string };
    expect(written.slug).toBe(ALLOWLISTED_SLUG);
    // The write lands under the REQUESTED slug in lg-private (put_page does
    // not rewrite the matched private page it found via candidateKeys).
    const inPrivate = await engine.getPage(ALLOWLISTED_SLUG, { sourceId: 'lg-private' });
    expect(inPrivate).not.toBeNull();
    expect(inPrivate!.compiled_truth).toContain('Allowlisted stub body');
    const inDefault = await engine.getPage(ALLOWLISTED_SLUG, { sourceId: 'default' });
    expect(inDefault).toBeNull();
  });

  test('local caller: allowlisted collision stays in default WITH an allowlist row', async () => {
    writeFileSync(allowlistPath, 'collision|' + ALLOWLISTED_SLUG + '\n');
    const written = await putPage.handler(makeCtx({ remote: false }), {
      slug: ALLOWLISTED_SLUG,
      content: CONTENT,
    }) as { slug: string };
    expect(written.slug).toBe(ALLOWLISTED_SLUG);
    // The allowlist exempts this live collision from private routing. The
    // existing private row remains unchanged and the requested default row
    // is updated in place.
    const inPrivate = await engine.getPage('lgv-allowlist-fence-test', { sourceId: 'lg-private' });
    expect(inPrivate).not.toBeNull();
    expect(inPrivate!.compiled_truth).toBe('Private copy.');
    const inDefault = await engine.getPage(ALLOWLISTED_SLUG, { sourceId: 'default' });
    expect(inDefault).not.toBeNull();
    expect(inDefault!.compiled_truth).toContain('Allowlisted stub body');
  });

  test('remote caller: allowlisted slug is refused (no allowlist row)', async () => {
    await expect(
      putPage.handler(makeCtx({ remote: true }), { slug: ALLOWLISTED_SLUG, content: CONTENT }),
    ).rejects.toThrow(/routed to private source.*cannot be written by a remote caller/);
  });

  test('remote caller: allowlisted slug is STILL refused WITH an allowlist row (defect 1 core case)', async () => {
    writeFileSync(allowlistPath, 'collision|' + ALLOWLISTED_SLUG + '\n');
    let caught: unknown;
    try {
      await putPage.handler(makeCtx({ remote: true }), { slug: ALLOWLISTED_SLUG, content: CONTENT });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationError);
    expect((caught as OperationError).code).toBe('permission_denied');
    expect((caught as Error).message).toMatch(/routed to private source 'lg-private' and cannot be written by a remote caller/);
    // And nothing was written to either source.
    const inDefault = await engine.getPage(ALLOWLISTED_SLUG, { sourceId: 'default' });
    expect(inDefault).toBeNull();
  });

  test('local caller: a NON-allowlisted, non-colliding slug is unaffected (control)', async () => {
    const slug = 'person/plain-control-slug';
    const written = await putPage.handler(makeCtx({ remote: false }), {
      slug,
      content: '---\ntype: concept\ntitle: Plain Control\n---\n\nOrdinary body.\n',
    }) as { slug: string };
    expect(written.slug).toBe(slug);
    const inDefault = await engine.getPage(slug, { sourceId: 'default' });
    expect(inDefault).not.toBeNull();
  });
});
