// An exact dir-hint slug is the canonical attendance target when its only
// rivals are `/_author` title twins outside the hint. Strict attendance
// resolution requires ONE row across slug, title and alias evidence, so
// `Alice Example` stopped resolving to `people/alice-example` once
// `wiki/alice-example/_author` (same title, also type person) existed, and
// the meeting published no links. Any other rival keeps the old result (null).
// P7: a private-source person never answers a default-source meeting.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageType } from '../src/core/types.ts';
import { extractPageLinks, makeResolver } from '../src/core/link-extraction.ts';
import { resolveCandidateSources } from '../src/core/link-reconciliation.ts';

const canonical = 'people/alice-example';
const authorTwin = 'wiki/alice-example/_author';

type Row = { slug: string; exact: boolean; in_hint: boolean };

function resolveWith(rows: Row[], value = 'Alice Example'): Promise<string | null> {
  const fake: Pick<BrainEngine, 'executeRaw'> = { executeRaw: async <T>() => rows as T[] };
  const resolver = makeResolver(fake as BrainEngine, { mode: 'batch', sourceId: 'default' });
  return resolver.resolveAttendance!(value, 'people');
}

describe('resolveAttendance tie-break (fake engine rows)', () => {
  const exactRow: Row = { slug: canonical, exact: true, in_hint: true };
  test('a unique exact dir-hint slug outranks `/_author` twins outside the hint', async () => {
    expect(await resolveWith([exactRow, { slug: authorTwin, exact: false, in_hint: false }])).toBe(canonical);
  });
  test('a real person outside the hint (contacts/) keeps the name ambiguous', async () => {
    expect(await resolveWith([exactRow, { slug: 'contacts/alice-example', exact: false, in_hint: false }])).toBeNull();
    expect(await resolveWith([exactRow, { slug: authorTwin, exact: false, in_hint: false },
      { slug: 'companies/acme/alice-example', exact: false, in_hint: false }])).toBeNull();
  });
  test('a rival under the dir hint keeps the name ambiguous (A1)', async () => {
    expect(await resolveWith([exactRow, { slug: 'people/alice-twin', exact: false, in_hint: true }])).toBeNull();
  });
  test('two exact slugs stay ambiguous', async () => {
    expect(await resolveWith([exactRow, { slug: 'people/alice-éxample', exact: true, in_hint: true }])).toBeNull();
  });
  test('a slug-path value never uses the tie-break (A1 pin in attendance-repair.test.ts)', async () => {
    expect(await resolveWith([exactRow, { slug: authorTwin, exact: false, in_hint: false }], canonical)).toBeNull();
    expect(await resolveWith([exactRow], canonical)).toBe(canonical);
  });
  test('without an exact slug, title or alias evidence must still be unique', async () => {
    expect(await resolveWith([{ slug: canonical, exact: false, in_hint: true }, { slug: authorTwin, exact: false, in_hint: false }])).toBeNull();
    expect(await resolveWith([{ slug: authorTwin, exact: false, in_hint: false }])).toBe(authorTwin);
    expect(await resolveWith([])).toBeNull();
  });
});

describe('attendance against a real engine (PGLite)', () => {
  let engine: BrainEngine;
  const meetingFm = (name: string) => ({ attendees: [{ name, email: 'a@example.com' }] });
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    for (const id of ['default', 'lg-private']) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [id]);
    }
    const put = (slug: string, type: PageType, title: string, sourceId: string) =>
      engine.putPage(slug, { type, title, compiled_truth: `${title} page`, frontmatter: {} }, { sourceId, allowEmptyOverwrite: true });
    await put(canonical, 'person', 'Alice Example', 'default');
    await put(authorTwin, 'person', 'Alice Example', 'default');
    await put('alice-example/_author', 'person', 'Alice Example', 'default');
    // Title-only twins with no canonical slug: must stay ambiguous.
    await put('wiki/carol-sample/_author', 'person', 'Carol Sample', 'default');
    await put('carol-sample/_author', 'person', 'Carol Sample', 'default');
    // A second person under people/ with the same title: genuine ambiguity.
    await put('people/erin-example', 'person', 'Erin Example', 'default');
    await put('people/erin-example-2', 'person', 'Erin Example', 'default');
    // A real person under contacts/ with the same title: stays ambiguous.
    await put('people/frank-example', 'person', 'Frank Example', 'default');
    await put('contacts/frank-example', 'person', 'Frank Example', 'default');
    // Five rows: three `/_author` twins that sort before a contacts/ rival by slug.
    await put('people/grace-example', 'person', 'Grace Example', 'default');
    for (const dir of ['a', 'b', 'c']) await put(`${dir}/grace-example/_author`, 'person', 'Grace Example', 'default');
    await put('contacts/grace-example', 'person', 'Grace Example', 'default');
    // Five rows, all rivals are `/_author` twins outside the hint: resolves.
    await put('people/hank-example', 'person', 'Hank Example', 'default');
    for (const dir of ['a', 'b', 'c', 'd']) await put(`${dir}/hank-example/_author`, 'person', 'Hank Example', 'default');
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

  test('a same-titled real person under contacts/ keeps the old result (null)', async () => {
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    expect(await resolver.resolveAttendance!('Frank Example', 'people')).toBeNull();
  });

  test('with 4 or more rivals, a contacts/ rival behind `/_author` twins still surfaces', async () => {
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    expect(await resolver.resolveAttendance!('Grace Example', 'people')).toBeNull();
    expect(await resolver.resolveAttendance!('Hank Example', 'people')).toBe('people/hank-example');
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
