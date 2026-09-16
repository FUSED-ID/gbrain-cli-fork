import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { __privateSourceRoutingTest, resolvePrivateWriteSource } from '../src/core/private-source-routing.ts';

function policyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-prefix-match-'));
  writeFileSync(join(dir, '_brain-filing-rules.md'), '# private filing rules\n');
  writeFileSync(join(dir, '_excluded-people.md'), `# Excluded People

## Family deny-list

| Slug pattern | Name | Relationship | DOB |
|---|---|---|---|
| \`julie-anne-vandenberg\` | Julie Anne Vandenberg | Spouse | - |
| \`celeste-no-star\` | Celeste No Star | Family | - |
| \`marin-no-star\` | Marin No Star | Family | - |
| \`christophe-vandenberg*\` | Christophe Atticus Vandenberg | Son | - |
| \`william-vandenberg*\` | William Leonardo Vandenberg | Son | - |
| \`albert-bausch*\` | Albert Bausch | Family | - |
| \`g-pavlov-kuna-family*\` | G. Pavlov Kuna Family | Family | - |
`);
  return dir;
}

function fakeEngine(dir: string): BrainEngine {
  return {
    executeRaw: async () => [
      { id: 'default', name: 'Default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      { id: 'lg-private', name: 'Private', local_path: dir, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
    ],
    getPage: async () => null,
  } as unknown as BrainEngine;
}

describe('D1 deny-list prefix matching', () => {
  test('prefix-routes bare, wiki, person, and author-normalized shapes', async () => {
    const engine = fakeEngine(policyDir());
    const cases = [
      'julie-anne-vandenberg-probe-b-20260916',
      'wiki/julie-anne-vandenberg-probe-b-20260916',
      'person/julie-anne-vandenberg-notes-20260916',
      'wiki/julie-anne-vandenberg/_author',
      'celeste-no-star-probe-20260916',
      'person/celeste-no-star-notes-20260916',
      'marin-no-star-probe-20260916',
      'wiki/marin-no-star-notes-20260916/_author',
    ];

    const routes = [];
    for (const slug of cases) {
      const route = await resolvePrivateWriteSource(engine, {
        requestedSourceId: 'default',
        slug,
        entityType: 'person',
      });
      routes.push({ slug, sourceId: route.sourceId, reason: route.reason });
    }
    console.log(`PREFIX RED/GREEN routes: ${JSON.stringify(routes)}`);
    expect(routes.every((route) => route.sourceId === 'lg-private')).toBe(true);
    expect(routes.every((route) => route.reason === 'excluded_people_policy')).toBe(true);
  });

  test('keeps every existing wildcard entry working as before', async () => {
    const engine = fakeEngine(policyDir());
    const slugs = [
      'wiki/christophe-vandenberg-probe-20260916/_author',
      'wiki/william-vandenberg-probe-20260916/_author',
      'wiki/albert-bausch-probe-20260916/_author',
      'wiki/g-pavlov-kuna-family-probe-20260916/_author',
    ];
    for (const slug of slugs) {
      const route = await resolvePrivateWriteSource(engine, {
        requestedSourceId: 'default',
        slug,
        entityType: 'person',
      });
      expect(route.sourceId).toBe('lg-private');
      expect(route.reason).toBe('excluded_people_policy');
    }
  });

  test('does not catch ordinary-word, surname-prefix, or mid-string controls', async () => {
    const engine = fakeEngine(policyDir());
    const cases = [
      'will-update-ordinary-word-20260916',
      'vandenberg-energy-labs-20260916',
      'notes-about-julie-anne-vandenberg-20260916',
    ];
    const routes = [];
    for (const slug of cases) {
      const route = await resolvePrivateWriteSource(engine, {
        requestedSourceId: 'default',
        slug,
        entityType: 'person',
      });
      routes.push({ slug, sourceId: route.sourceId, routed: route.routed });
    }
    console.log(`CONTROL routes: ${JSON.stringify(routes)}`);
    expect(routes).toEqual([
      { slug: cases[0], sourceId: 'default', routed: false },
      { slug: cases[1], sourceId: 'default', routed: false },
      { slug: cases[2], sourceId: 'default', routed: false },
    ]);
  });

  test('matches only the normalized key prefix, never a mid-string occurrence', () => {
    const source = { local_path: policyDir() } as Parameters<typeof __privateSourceRoutingTest.matchesExcludedPeople>[0];
    const matches = __privateSourceRoutingTest.matchesExcludedPeople;
    expect(matches(source, { slug: 'wiki/julie-anne-vandenberg-probe-20260916', entityType: 'person' })).toBe(true);
    expect(matches(source, { slug: 'notes-about-julie-anne-vandenberg-20260916', entityType: 'person' })).toBe(false);
  });
});
