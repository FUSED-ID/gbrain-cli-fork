/**
 * R1 + R3 register defects, measured before they are fixed.
 *
 * R3: the deny-list Name cell `G. Pavlov / Kuna Family` is one table cell holding
 *     TWO names. normalizeName collapses it to the single key
 *     `g-pavlov-kuna-family`, so neither `G. Pavlov` nor `Kuna Family` matches on
 *     its own. The pre-existing d1-prefix-match-regression test sidestepped this
 *     by writing the fixture WITHOUT the slash.
 *
 * R1: isAllowlistedCollision exact-matches while the deny-list prefix-matches.
 *     This file measures what each arm actually does rather than restating the
 *     register's claim.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { isAllowlistedCollision, resolvePrivateWriteSource } from '../src/core/private-source-routing.ts';

/** The real Name cell, slash and all. This is the point of the fixture. */
function policyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-r1r3-'));
  writeFileSync(join(dir, '_brain-filing-rules.md'), '# private filing rules\n');
  writeFileSync(join(dir, '_excluded-people.md'), `# Excluded People

## Family deny-list

| Slug pattern | Name | Relationship | DOB |
|---|---|---|---|
| \`julie-anne-vandenberg\` | Julie Anne Vandenberg | Spouse | - |
| \`g-pavlov-kuna-family*\` | G. Pavlov / Kuna Family | Personal family friends | - |
`);
  return dir;
}

function fakeEngine(dir: string, privatePages: string[] = []): BrainEngine {
  const live = new Set(privatePages);
  return {
    executeRaw: async () => [
      { id: 'default', name: 'Default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      { id: 'lg-private', name: 'Private', local_path: dir, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
    ],
    getPage: async (slug: string) => (live.has(slug) ? { id: 1, slug } : null),
  } as unknown as BrainEngine;
}

async function routeFor(engine: BrainEngine, slug: string, entityName?: string) {
  return resolvePrivateWriteSource(engine, {
    requestedSourceId: 'default',
    slug,
    entityType: 'person',
    ...(entityName ? { entityName } : {}),
  });
}

describe('R3 — both names in a shared deny-list Name cell', () => {
  test('a page carrying only the G. Pavlov half routes to lg-private', async () => {
    const engine = fakeEngine(policyDir());
    const byName = await routeFor(engine, 'person/some-unrelated-slug', 'G. Pavlov');
    const bySlug = await routeFor(engine, 'person/g-pavlov');
    console.log(`R3 g-pavlov: byName=${JSON.stringify(byName)} bySlug=${JSON.stringify(bySlug)}`);
    expect(byName.sourceId).toBe('lg-private');
    expect(bySlug.sourceId).toBe('lg-private');
  });

  test('a page carrying only the Kuna Family half routes to lg-private', async () => {
    const engine = fakeEngine(policyDir());
    const byName = await routeFor(engine, 'person/some-other-slug', 'Kuna Family');
    const bySlug = await routeFor(engine, 'person/kuna-family');
    console.log(`R3 kuna-family: byName=${JSON.stringify(byName)} bySlug=${JSON.stringify(bySlug)}`);
    expect(byName.sourceId).toBe('lg-private');
    expect(bySlug.sourceId).toBe('lg-private');
  });

  test('the combined form still matches, nothing regresses', async () => {
    const engine = fakeEngine(policyDir());
    const combined = await routeFor(engine, 'person/g-pavlov-kuna-family-notes');
    console.log(`R3 combined: ${JSON.stringify(combined)}`);
    expect(combined.sourceId).toBe('lg-private');
  });

  test('an unrelated person is NOT swept in by the split', async () => {
    const engine = fakeEngine(policyDir());
    const cases = ['person/pavlova-recipe', 'person/kuna-industries-ltd', 'person/hicham-batou'];
    const routes = [];
    for (const slug of cases) routes.push({ slug, ...(await routeFor(engine, slug)) });
    console.log(`R3 no-oversweep: ${JSON.stringify(routes)}`);
    expect(routes.every((r) => r.sourceId === 'default')).toBe(true);
  });
});

describe('R1 — allowlist vs deny-list matcher shapes, measured', () => {
  test('MEASUREMENT: what the allowlist arm actually does with a suffixed slug', async () => {
    process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-r1-allow-'));
      const file = join(dir, 'privacy-allowlist.tsv');
      writeFileSync(file, '# fixture\ncollision|person/lgv\n');
      return file;
    })();
    const exact = isAllowlistedCollision('default', 'person/lgv');
    const suffix = isAllowlistedCollision('default', 'person/lgv-suffix');
    const dated = isAllowlistedCollision('default', 'person/lgv-2026');
    const child = isAllowlistedCollision('default', 'person/lgv/notes');
    console.log(`R1 allowlist: exact=${exact} suffix=${suffix} dated=${dated} child=${child}`);
    // REGRESSION LOCK. The allowlist must stay EXACT. A future "alignment" to
    // prefix matching would exempt person/lgv-2026 and every other suffix from
    // rule (b) and publish them to the world-visible source. See the R1 block
    // on isAllowlistedCollision.
    expect(exact).toBe(true);
    expect(suffix).toBe(false);
    expect(dated).toBe(false);
    expect(child).toBe(false);
  });

  test('MEASUREMENT: does person/lgv-2026 actually route, as the register claims', async () => {
    // A live private page at person/lgv, which is the real estate shape.
    const engine = fakeEngine(policyDir(), ['person/lgv']);
    const base = await routeFor(engine, 'person/lgv');
    const dated = await routeFor(engine, 'person/lgv-2026');
    const suffix = await routeFor(engine, 'person/lgv-suffix');
    console.log(`R1 routes: base=${JSON.stringify(base)} dated=${JSON.stringify(dated)} suffix=${JSON.stringify(suffix)}`);
    // MEASURED, and it REFUTES the register's R1 consequence. Neither the
    // dated nor the suffixed slug routes anywhere: both stay in default,
    // routed:false. The allowlisted base slug is the only one rule (b) touches.
    expect(base.routed).toBe(true);
    expect(base.sourceId).toBe('default');          // allowlist exemption applied
    expect(base.reason).toBe('existing_private_page');
    expect(dated.sourceId).toBe('default');
    expect(dated.routed).toBe(false);
    expect(suffix.sourceId).toBe('default');
    expect(suffix.routed).toBe(false);
    expect(base.privateSourceId).toBe('lg-private');
  });
});
