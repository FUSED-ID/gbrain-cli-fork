// Q12 (2026-11-24): an exact dir-hint slug is the canonical attendance target.
// v0.58 (#5458) made strict attendance resolution require ONE row across slug,
// title and alias evidence, so `Michael Anthony` stopped resolving to
// `people/michael-anthony` once `wiki/michael-anthony/_author` (same title, also
// type person) existed. The meeting then counted as attendance-incomplete and
// published no links at all. These tests pin the precedence and the P7 source
// partition (a private-source person never answers a default-source meeting).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractPageLinks, makeResolver, pickAttendanceMatch } from '../src/core/link-extraction.ts';
import { resolveCandidateSources } from '../src/core/link-reconciliation.ts';

const canonical = 'people/alice-example';
const authorTwin = 'wiki/alice-example/_author';

describe('pickAttendanceMatch', () => {
  const exactRow = { slug: canonical, exact: true, in_hint: true };
  test('a unique exact dir-hint slug outranks same-titled pages outside the hint', () => {
    expect(pickAttendanceMatch([exactRow, { slug: authorTwin, exact: false, in_hint: false }])).toBe(canonical);
  });
  test('a rival under the dir hint keeps the name ambiguous (A1)', () => {
    expect(pickAttendanceMatch([exactRow, { slug: 'people/alice-twin', exact: false, in_hint: true }])).toBeNull();
  });
  test('two exact slugs stay ambiguous', () => {
    expect(pickAttendanceMatch([exactRow, { slug: 'people/alice-éxample', exact: true, in_hint: true }])).toBeNull();
  });
  test('a path-shaped value never uses the tie-break (A1 pin in attendance-repair.test.ts)', () => {
    expect(pickAttendanceMatch([exactRow, { slug: authorTwin, exact: false, in_hint: false }], { pathShaped: true })).toBeNull();
    expect(pickAttendanceMatch([exactRow], { pathShaped: true })).toBe(canonical);
  });
  test('without an exact slug, title or alias evidence must still be unique', () => {
    expect(pickAttendanceMatch([{ slug: canonical, exact: false, in_hint: true }, { slug: authorTwin, exact: false, in_hint: false }])).toBeNull();
    expect(pickAttendanceMatch([{ slug: authorTwin, exact: false, in_hint: false }])).toBe(authorTwin);
    expect(pickAttendanceMatch([{ slug: canonical }])).toBe(canonical);
    expect(pickAttendanceMatch([{ slug: canonical }, { slug: authorTwin }])).toBeNull();
    expect(pickAttendanceMatch([])).toBeNull();
  });
});

test('strict attendance resolves the exact slug when a title twin exists (mocked rows)', async () => {
  const engine = { async executeRaw() { return [{ slug: canonical, exact: true, in_hint: true }, { slug: authorTwin, exact: false, in_hint: false }]; } };
  const resolver = makeResolver(engine as never, { mode: 'batch', sourceId: 'default' });
  expect(await resolver.resolveAttendance!('Alice Example', 'people')).toBe(canonical);
});

describe('attendance against a real engine (PGLite)', () => {
  let engine: BrainEngine;
  const meetingFm = (name: string) => ({ attendees: [{ name, email: 'a@example.com' }] });
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    for (const id of ['default', 'lg-private']) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [id]);
    }
    const put = (slug: string, type: string, title: string, sourceId: string) =>
      engine.putPage(slug, { type, title, compiled_truth: `${title} page`, frontmatter: {} } as never, { sourceId, allowEmptyOverwrite: true } as never);
    await put(canonical, 'person', 'Alice Example', 'default');
    await put(authorTwin, 'person', 'Alice Example', 'default');
    await put('alice-example/_author', 'person', 'Alice Example', 'default');
    // Title-only twins with no canonical slug: must stay ambiguous.
    await put('wiki/carol-sample/_author', 'person', 'Carol Sample', 'default');
    await put('carol-sample/_author', 'person', 'Carol Sample', 'default');
    // A second person under people/ with the same title: genuine ambiguity.
    await put('people/erin-example', 'person', 'Erin Example', 'default');
    await put('people/erin-example-2', 'person', 'Erin Example', 'default');
    // P7: exists ONLY in the private source.
    await put('people/bob-private', 'person', 'Bob Private', 'lg-private');
    // P7: canonical slug in default, a same-slug private twin must not interfere either way.
    await put('people/dana-shared', 'person', 'Dana Shared', 'default');
    await put('people/dana-shared', 'person', 'Dana Shared', 'lg-private');
    await put('meetings/planning', 'meeting', 'Planning', 'default');
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('meeting attendee resolves to the canonical person and the page is attendance-complete', async () => {
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    const result = await extractPageLinks('meetings/planning', 'Notes.', meetingFm('Alice Example'), 'meeting', resolver,
      { targetType: slug => (slug.startsWith('people/') || slug.endsWith('/_author')) ? 'person' : undefined });
    expect(result.attendanceComplete).toBe(true);
    expect(result.candidates.filter(c => c.linkType === 'attended').map(c => [c.fromSlug, c.targetSlug]))
      .toEqual([[canonical, 'meetings/planning']]);
  });

  test('title twins with no canonical slug, or a rival under people/, remain unresolved (no guessing)', async () => {
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    expect(await resolver.resolveAttendance!('Carol Sample', 'people')).toBeNull();
    expect(await resolver.resolveAttendance!('Erin Example', 'people')).toBeNull();
  });

  test('P7: a private-source person never resolves from a default-source page', async () => {
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    expect(await resolver.resolveAttendance!('Bob Private', 'people')).toBeNull();
    expect(await resolver.resolveAttendance!('people/bob-private', 'people')).toBeNull();
    expect(await resolver.resolveAttendance!('lg-private:people/bob-private', 'people')).toBeNull();
    expect(await resolver.resolve('Bob Private', 'people')).toBeNull();
    const result = await extractPageLinks('meetings/planning', 'Notes.', meetingFm('Bob Private'), 'meeting', resolver,
      { targetType: slug => slug.startsWith('people/') ? 'person' : undefined });
    expect(result.attendanceComplete).toBe(false);
    expect(result.candidates.filter(c => c.targetSlug === 'people/bob-private' || c.fromSlug === 'people/bob-private')).toEqual([]);
    // And the edge admission gate refuses a default-origin edge into the private-only slug.
    const refs = [{ slug: 'people/bob-private', source_id: 'lg-private' }, { slug: 'meetings/planning', source_id: 'default' }];
    const allSlugs = new Set(refs.map(r => r.slug));
    const slugToSources = new Map(refs.map(r => [r.slug, [r.source_id]]));
    const admitted = resolveCandidateSources({ fromSlug: 'people/bob-private', targetSlug: 'meetings/planning', linkType: 'attended', context: '' },
      'meetings/planning', 'default', allSlugs, slugToSources, false, { crossSource: false, defaultSourceId: 'default' });
    expect(admitted.ok).toBe(false);
  });

  test('P7: the exact-slug tier is source-scoped (default resolver answers its own slug, private resolver its own)', async () => {
    const def = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    const priv = makeResolver(engine, { mode: 'batch', sourceId: 'lg-private' });
    expect(await def.resolveAttendance!('Dana Shared', 'people')).toBe('people/dana-shared');
    expect(await priv.resolveAttendance!('Dana Shared', 'people')).toBe('people/dana-shared');
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug='people/alice-example' AND source_id='lg-private'`);
    expect(rows[0].n).toBe(0);
    expect(await priv.resolveAttendance!('Alice Example', 'people')).toBeNull();
  });
});
