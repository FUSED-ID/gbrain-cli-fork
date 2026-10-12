import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'fable9-home-test-'));
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { forgetFactInFence } = await import('../src/core/facts/forget.ts');
const { importFromContent } = await import('../src/core/import-file.ts');
const { writeSingleFact } = await import('../src/core/facts/write-single.ts');
const { operationsByName } = await import('../src/core/operations.ts');

const policyDir = mkdtempSync(join(tmpdir(), 'fable9-policy-test-'));
const brainDir = mkdtempSync(join(tmpdir(), 'fable9-brain-test-'));
const allow = join(policyDir, 'allow.tsv');
process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = allow;
copyFileSync('/Users/lg/gbrain-private/_excluded-people.md', join(policyDir, '_excluded-people.md'));
copyFileSync('/Users/lg/gbrain-private/_brain-filing-rules.md', join(policyDir, '_brain-filing-rules.md'));
const REAL_DENY = readFileSync(join(policyDir, '_excluded-people.md'), 'utf8');
writeFileSync(allow, 'collision|people/lgv\ncollision|chris-hooper/_author\ncollision|wiki/chris-hooper/_author\n');

let engine: InstanceType<typeof PGLiteEngine>;

async function probe(label: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`ALLOWED  ${label}  ${JSON.stringify(r)?.slice(0, 160)}`);
    return { ok: true, r };
  } catch (e) {
    console.log(`REFUSED  ${label}  ${String(e).slice(0, 170)}`);
    return { ok: false, e };
  }
}

const page = (title: string, type = 'note', body = 'body') => ({ type, title, compiled_truth: body, timeline: '', frontmatter: {} });
const seedDefault = (slug: string, title: string, type = 'note', body = 'leaked body') =>
  engine.putPage(slug, page(title, type, body), { sourceId: 'default', migrationWrite: true });
const seedFact = async (slug: string, txt = 'leaked fact', rowNum: number | null = 1) => {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source) VALUES ('default',$1,$1,$2,$3,'fact','world','p') RETURNING id`, [slug, rowNum, txt]);
  return Number(rows[0].id);
};
const factRow = (id: number) => engine.executeRaw<any>('SELECT id, source_id, expired_at, superseded_by, valid_until, visibility FROM facts WHERE id=$1', [id]).then(r => r[0]);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`UPDATE sources SET local_path=$1, config = jsonb_set(jsonb_set(COALESCE(config,'{}'::jsonb),'{federated}','true'::jsonb),'{facts_visibility}','"world"'::jsonb) WHERE id='default'`, [brainDir]);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private','LG private',$1,'{}'::jsonb)`, [policyDir]);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  if (existsSync(brainDir)) rmSync(brainDir, { recursive: true, force: true });
  if (existsSync(policyDir)) rmSync(policyDir, { recursive: true, force: true });
});

async function clearProbeRows(): Promise<void> {
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
}

describe('Fable round 9 focused acceptance assertions', () => {
  test('A: refreshPageBody cannot be unlocked by a caller-supplied effect', async () => {
    await clearProbeRows();
    await seedDefault('wiki/albert-bausch', 'Albert Bausch', 'person', 'original body');
    await expect((engine.refreshPageBody as any)(
      'wiki/albert-bausch', 'default', 'BRAND NEW SECRET CONTENT', '', 'h1', { effect: 'reduce' },
    )).rejects.toThrow(/routed|refus|world-federated/i);
    await expect(engine.getPage('wiki/albert-bausch', { sourceId: 'default' })).resolves.toMatchObject({ compiled_truth: 'original body' });
  });

  test('B: all three allowlisted collisions stay live in both sources across two imports', async () => {
    await clearProbeRows();
    const cases = [
      ['people/lgv', 'LGV'],
      ['chris-hooper/_author', 'Chris Hooper'],
      ['wiki/chris-hooper/_author', 'Chris Hooper'],
    ] as const;
    for (const [slug, title] of cases) {
      await engine.putPage(slug, page(title, 'person', `PRIVATE ${slug}`), { sourceId: 'lg-private' });
      await engine.putPage(slug, page(title, 'person', `PUBLIC ${slug}`), { sourceId: 'default', migrationWrite: true });
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const [slug, title] of cases) {
        await importFromContent(engine, slug, `---\ntype: person\ntitle: ${title}\n---\n\nPUBLIC ${slug} SYNC ${pass}\n`, { sourceId: 'default', noEmbed: true });
      }
    }
    for (const [slug] of cases) {
      await expect(engine.getPage(slug, { sourceId: 'lg-private' })).resolves.toMatchObject({ compiled_truth: `PRIVATE ${slug}` });
      await expect(engine.getPage(slug, { sourceId: 'default' })).resolves.not.toBeNull();
      await expect(engine.getPage(slug, { sourceId: 'default', includeDeleted: true })).resolves.toMatchObject({ deleted_at: null });
    }
  });

  test('C: PGLite restorePage uses the page-write guard', async () => {
    await clearProbeRows();
    await seedDefault('wiki/albert-bausch', 'Albert Bausch', 'person');
    await expect(engine.softDeletePage('wiki/albert-bausch', { sourceId: 'default' })).resolves.toMatchObject({ slug: 'wiki/albert-bausch' });
    await expect(engine.restorePage('wiki/albert-bausch', { sourceId: 'default' })).rejects.toThrow(/routed|refus|world-federated/i);
    await expect(engine.getPage('wiki/albert-bausch', { sourceId: 'default' })).resolves.toBeNull();
  });
});

describe('Fable round 9 probe.ts', () => {
  test('preserves the full D1/D3 probe and enforces the ruling', async () => {
    console.log('\n=== D1: exposure-REDUCING writes on deny-listed rows already in default ===');
    await seedDefault('wiki/albert-bausch', 'Albert Bausch', 'person');
    await seedDefault('wiki/g-pavlov-kuna-family', 'G Pavlov Kuna Family', 'note');
    let id = await seedFact('wiki/albert-bausch');
    expect((await probe('expireFact(albert fact in default)', async () => { const ok = await engine.expireFact(id); return { ok, row: await factRow(id) }; })).ok).toBe(true);
    expect((await probe('softDeletePage(wiki/albert-bausch, default)', () => engine.softDeletePage('wiki/albert-bausch', { sourceId: 'default' }))).ok).toBe(true);
    expect(await engine.getPage('wiki/albert-bausch', { sourceId: 'default' })).toBeNull();
    expect((await probe('softDeletePage(wiki/g-pavlov-kuna-family) no sourceId', () => engine.softDeletePage('wiki/g-pavlov-kuna-family'))).ok).toBe(true);
    expect((await probe('deletePage (hard) wiki/g-pavlov-kuna-family', () => engine.deletePage('wiki/g-pavlov-kuna-family', { sourceId: 'default' }))).ok).toBe(true);
    expect(await engine.getPage('wiki/g-pavlov-kuna-family', { sourceId: 'default', includeDeleted: true })).toBeNull();
    await seedDefault('people/julie-anne-vandenberg', 'Julie Anne Vandenberg', 'person');
    expect((await probe('softDeletePages batch [people/julie-anne-vandenberg]', () => engine.softDeletePages(['people/julie-anne-vandenberg'], { sourceId: 'default' }))).ok).toBe(true);

    console.log('\n=== D1: CREATING / RESTORING writes into default must refuse ===');
    expect((await probe('restorePage(wiki/albert-bausch) ENGINE seam', () => engine.restorePage('wiki/albert-bausch', { sourceId: 'default' }))).ok).toBe(false);
    expect(await engine.getPage('wiki/albert-bausch', { sourceId: 'default' })).toBeNull();
    expect((await probe('restorePage(people/julie-anne-vandenberg) ENGINE seam', () => engine.restorePage('people/julie-anne-vandenberg', { sourceId: 'default' }))).ok).toBe(false);
    expect(await engine.getPage('people/julie-anne-vandenberg', { sourceId: 'default' })).toBeNull();
    await seedDefault('wiki/albert-bausch', 'Albert Bausch', 'person');
    expect((await probe('putPage wiki/albert-bausch default (no migrationWrite)', () => engine.putPage('wiki/albert-bausch', page('Albert Bausch','person'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('putPage notes/innocuous title "Albert Bausch"', () => engine.putPage('notes/innocuous', page('Albert Bausch','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('putPage wiki/g-pavlov-kuna-family type note', () => engine.putPage('wiki/g-pavlov-kuna-family', page('G Pavlov Kuna Family','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('putPage wiki/alex-bausch person (SHARED, expect ALLOWED)', () => engine.putPage('wiki/alex-bausch', page('Alex Bausch','person'), { sourceId: 'default' }))).ok).toBe(true);
    expect((await probe('putPage notes/ordinary (expect ALLOWED)', () => engine.putPage('notes/ordinary', page('Ordinary note','note'), { sourceId: 'default' }))).ok).toBe(true);
    expect((await probe('insertFact albert world', () => engine.insertFact({ fact: 'x', entity_slug: 'wiki/albert-bausch', visibility: 'world', source: 'p' } as any, { source_id: 'default' }))).ok).toBe(false);
    expect((await probe('insertFact albert PRIVATE visibility', () => engine.insertFact({ fact: 'x', entity_slug: 'wiki/albert-bausch', visibility: 'private', source: 'p' } as any, { source_id: 'default' }))).ok).toBe(false);
    expect((await probe('insertFact albert supersede branch', () => engine.insertFact({ fact: 'x', entity_slug: 'wiki/albert-bausch', visibility: 'world', source: 'p' } as any, { source_id: 'default', supersedeId: id }))).ok).toBe(false);
    expect((await probe('insertFact alex-bausch world (expect ALLOWED)', () => engine.insertFact({ fact: 'x', entity_slug: 'wiki/alex-bausch', visibility: 'world', source: 'p' } as any, { source_id: 'default' }))).ok).toBe(true);
    expect((await probe('insertFacts batch [ordinary, albert] (expect refuse whole batch)', () => engine.insertFacts([
      { fact: 'a', entity_slug: 'notes/ordinary', source_markdown_slug: 'notes/ordinary', row_num: 1, visibility: 'world', source: 'p' },
      { fact: 'b', entity_slug: 'wiki/albert-bausch', source_markdown_slug: 'wiki/albert-bausch', row_num: 1, visibility: 'world', source: 'p' }] as any, { source_id: 'default' }))).ok).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE entity_slug=$1', ['notes/ordinary'])).toEqual([]);
    expect((await probe('mergeOntologyFact albert', () => engine.mergeOntologyFact({ sourceId: 'default', entitySlug: 'wiki/albert-bausch', dimension: 'role', value: 'x', visibility: 'world', source: 'p' } as any))).ok).toBe(false);
    expect((await probe('mergeOntologyFact entitySlug=g-pavlov-kuna-family (bare)', () => engine.mergeOntologyFact({ sourceId: 'default', entitySlug: 'g-pavlov-kuna-family', dimension: 'role', value: 'x', visibility: 'world', source: 'p' } as any))).ok).toBe(false);
    expect((await probe('createVersion wiki/albert-bausch', () => engine.createVersion('wiki/albert-bausch', { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('refreshPageBody wiki/albert-bausch (no effect)', () => engine.refreshPageBody('wiki/albert-bausch', 'default', 'NEW CONTENT', '', 'h1'))).ok).toBe(false);
    expect((await probe('refreshPageBody effect=reduce with NEW content (must still refuse)', () => (engine.refreshPageBody as any)('wiki/albert-bausch', 'default', 'BRAND NEW SECRET CONTENT', '', 'h2', { effect: 'reduce' }))).ok).toBe(false);
    expect((await probe('body now', async () => (await engine.getPage('wiki/albert-bausch', { sourceId: 'default' }))?.compiled_truth)).r).not.toBe('BRAND NEW SECRET CONTENT');

    console.log('\n=== D1: forget on deny-listed page: expired_at set AND body mirror written ===');
    const fenceBody = `# Albert Bausch\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Albert lives in Spain | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->\n`;
    await engine.putPage('wiki/albert-bausch', { ...page('Albert Bausch','person', fenceBody), source_path: 'wiki/albert-bausch.md' } as any, { sourceId: 'default', migrationWrite: true });
    mkdirSync(join(brainDir, 'wiki'), { recursive: true });
    writeFileSync(join(brainDir, 'wiki/albert-bausch.md'), fenceBody);
    await engine.executeRaw('DELETE FROM facts');
    id = await seedFact('wiki/albert-bausch', 'Albert lives in Spain', 1);
    expect((await probe('forgetFactInFence(albert fact)', async () => ({ res: await forgetFactInFence(engine, id, { reason: 'cleanup' }), row: await factRow(id) }))).ok).toBe(true);
    expect((await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id = $1', [id]))[0].expired_at).not.toBeNull();
    expect((await engine.getPage('wiki/albert-bausch', { sourceId: 'default' }))?.compiled_truth).not.toContain('~~Albert lives in Spain~~');
    expect(readFileSync(join(brainDir, 'wiki/albert-bausch.md'),'utf8')).toContain('~~');

    console.log('\n=== D1-ADVERSARIAL: forget must not mirror drifted FILE into DB ===');
    await engine.executeRaw('DELETE FROM facts');
    const fenceBody2 = fenceBody.replace('<!--- gbrain:facts:end -->', '| 2 | Albert second claim | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->');
    await engine.putPage('wiki/albert-bausch', { ...page('Albert Bausch','person', fenceBody2), source_path: 'wiki/albert-bausch.md' } as any, { sourceId: 'default', migrationWrite: true });
    const drifted = fenceBody2.replace('# Albert Bausch\n', '# Albert Bausch\n\nSECRET-DRIFT: Albert medical detail added on disk after the DB row was written.\n');
    writeFileSync(join(brainDir, 'wiki/albert-bausch.md'), drifted);
    id = await seedFact('wiki/albert-bausch', 'Albert lives in Spain', 1);
    expect((await probe('forgetFactInFence with drifted file', async () => ({ res: await forgetFactInFence(engine, id, { reason: 'cleanup' }), row: await factRow(id) }))).ok).toBe(true);
    expect(((await engine.getPage('wiki/albert-bausch', { sourceId: 'default' }))?.compiled_truth ?? '')).not.toContain('SECRET-DRIFT');
    expect(readFileSync(join(brainDir, 'wiki/albert-bausch.md'), 'utf8')).not.toContain('SECRET-DRIFT');

    console.log('\n=== D1: routed put tombstones default and writes private ===');
    await engine.executeRaw(`DELETE FROM pages WHERE slug='wiki/g-pavlov-kuna-family'`);
    await seedDefault('wiki/g-pavlov-kuna-family', 'G Pavlov Kuna Family', 'note', 'LEAKED FAMILY BODY');
    const ctx = () => ({ engine, config: {}, logger: { info(){}, warn(){}, error(){} }, dryRun: false, remote: false, sourceId: 'default' } as any);
    expect((await probe('put_page op wiki/g-pavlov-kuna-family (local)', () => operationsByName.put_page.handler(ctx(), { slug: 'wiki/g-pavlov-kuna-family', content: '---\ntype: note\ntitle: G Pavlov Kuna Family\n---\n\nPrivate replacement.\n' }))).ok).toBe(true);
    expect(await engine.getPage('wiki/g-pavlov-kuna-family', { sourceId: 'lg-private' })).toMatchObject({ source_id: 'lg-private', compiled_truth: 'Private replacement.' });
    expect(await engine.getPage('wiki/g-pavlov-kuna-family', { sourceId: 'default' })).toBeNull();
    expect(await engine.getPage('wiki/g-pavlov-kuna-family', { sourceId: 'default', includeDeleted: true })).toMatchObject({ deleted_at: expect.anything(), compiled_truth: 'LEAKED FAMILY BODY' });
    expect((await probe('put_page op REMOTE wiki/g-pavlov-kuna-family (expect refused)', () => operationsByName.put_page.handler({ ...ctx(), remote: true }, { slug: 'wiki/g-pavlov-kuna-family', content: '---\ntype: note\ntitle: G Pavlov Kuna Family\n---\n\nremote.\n' }))).ok).toBe(false);
    expect((await probe('put_page op REMOTE notes/anything title Albert Bausch (expect refused)', () => operationsByName.put_page.handler({ ...ctx(), remote: true }, { slug: 'notes/anything2', content: '---\ntype: note\ntitle: Albert Bausch\n---\n\nremote.\n' }))).ok).toBe(false);
    expect(await engine.getPage('notes/anything2', { sourceId: 'default' })).toBeNull();
    expect(await engine.getPage('notes/anything2', { sourceId: 'lg-private' })).toBeNull();
    expect((await probe('importFromContent fresh routed slug wiki/albert-bausch-2', () => importFromContent(engine, 'wiki/albert-bausch-2', '---\ntype: person\ntitle: Albert Bausch\n---\n\nfresh.\n', { sourceId: 'default', noEmbed: true }))).ok).toBe(true);
    expect(await engine.getPage('wiki/albert-bausch-2', { sourceId: 'default', includeDeleted: true })).toBeNull();
    expect(await engine.getPage('wiki/albert-bausch-2', { sourceId: 'lg-private' })).toMatchObject({ source_id: 'lg-private' });
    expect((await probe('importFromContent with sourceId UNDEFINED albert-3', () => importFromContent(engine, 'wiki/albert-bausch-3', '---\ntype: person\ntitle: Albert Bausch\n---\n\nfresh.\n', { noEmbed: true }))).ok).toBe(true);
    expect(await engine.getPage('wiki/albert-bausch-3', { sourceId: 'default', includeDeleted: true })).toBeNull();
    expect(await engine.getPage('wiki/albert-bausch-3', { sourceId: 'lg-private' })).toMatchObject({ source_id: 'lg-private' });

    console.log('\n=== D1-ADVERSARIAL: three allowlisted collisions through importFromContent ===');
    for (const slug of ['people/lgv', 'chris-hooper/_author', 'wiki/chris-hooper/_author']) {
      await engine.putPage(slug, page(slug === 'people/lgv' ? 'LGV' : 'Chris Hooper', 'person', `PRIVATE ${slug}`), { sourceId: 'lg-private' });
      await engine.putPage(slug, page(slug === 'people/lgv' ? 'LGV' : 'Chris Hooper', 'person', `PUBLIC ${slug}`), { sourceId: 'default', migrationWrite: true });
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const slug of ['people/lgv', 'chris-hooper/_author', 'wiki/chris-hooper/_author']) {
        const title = slug === 'people/lgv' ? 'LGV' : 'Chris Hooper';
        expect((await probe(`importFromContent ${slug} sourceId default pass ${pass + 1}`, () => importFromContent(engine, slug, `---\ntype: person\ntitle: ${title}\n---\n\nPUBLIC ${slug} SYNC\n`, { sourceId: 'default', noEmbed: true }))).ok).toBe(true);
      }
    }
    for (const slug of ['people/lgv', 'chris-hooper/_author', 'wiki/chris-hooper/_author']) {
      expect((await engine.getPage(slug, { sourceId: 'lg-private' }))?.compiled_truth).toBe(`PRIVATE ${slug}`);
      expect(await engine.getPage(slug, { sourceId: 'default' })).not.toBeNull();
      expect((await engine.getPage(slug, { sourceId: 'default', includeDeleted: true }))?.deleted_at).toBeNull();
    }

    console.log('\n=== D3: gate gone, fail-closed ===');
    const resetDeny = () => writeFileSync(join(policyDir, '_excluded-people.md'), REAL_DENY);
    await engine.executeRaw(`DELETE FROM pages WHERE source_id='default' AND slug IN ('wiki/g-pavlov-kuna-family','notes/innocuous','people/julie-anne-vandenberg','notes/plain','wiki/alex-bausch')`);
    expect((await probe('D3 valid deny: putPage wiki/g-pavlov-kuna-family note', () => engine.putPage('wiki/g-pavlov-kuna-family', page('G Pavlov Kuna Family','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('D3 valid deny: putPage wiki/g-pavlov-kuna-family title Holiday notes', () => engine.putPage('wiki/g-pavlov-kuna-family', page('Holiday notes','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('D3 valid deny: putPage notes/innocuous title Albert Bausch', () => engine.putPage('notes/innocuous', page('Albert Bausch','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('D3 valid deny: putPage notes/opa-visit title Opa', () => engine.putPage('notes/opa-visit', page('Opa','note'), { sourceId: 'default' }))).ok).toBe(true);
    expect((await probe('D3 valid deny: putPage people/julie-anne-vandenberg', () => engine.putPage('people/julie-anne-vandenberg', page('Julie Anne Vandenberg','person'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('D3 valid deny: putPage wiki/alex-bausch', () => engine.putPage('wiki/alex-bausch', page('Alex Bausch','person'), { sourceId: 'default' }))).ok).toBe(true);
    expect((await probe('D3 valid deny: putPage notes/plain', () => engine.putPage('notes/plain', page('Plain','note'), { sourceId: 'default' }))).ok).toBe(true);
    expect((await probe('D3 valid deny: insertFact wiki/g-pavlov-kuna-family', () => engine.insertFact({ fact: 'x', entity_slug: 'wiki/g-pavlov-kuna-family', visibility: 'world', source: 'p' } as any, { source_id: 'default' }))).ok).toBe(false);
    for (const [label, mut] of [
      ['renamed heading', REAL_DENY.replace(/## Family deny-list/i, '## Family denylist')],
      ['corrupted (garbage)', 'not markdown policy'],
      ['empty file', ''],
    ] as const) {
      writeFileSync(join(policyDir, '_excluded-people.md'), mut);
      expect((await probe(`D3 ${label}: putPage notes/plain2`, () => engine.putPage('notes/plain2', page('Plain','note'), { sourceId: 'default' }))).ok).toBe(false);
      expect((await probe(`D3 ${label}: putPage wiki/g-pavlov-kuna-family`, () => engine.putPage('wiki/g-pavlov-kuna-family', page('G Pavlov Kuna Family','note'), { sourceId: 'default' }))).ok).toBe(false);
      expect((await probe(`D3 ${label}: putPage notes/innocuous2 title Albert Bausch`, () => engine.putPage('notes/innocuous2', page('Albert Bausch','note'), { sourceId: 'default' }))).ok).toBe(false);
      expect((await probe(`D3 ${label}: insertFact ordinary notes/plain`, () => engine.insertFact({ fact: 'x', entity_slug: 'notes/plain', visibility: 'world', source: 'p' } as any, { source_id: 'default' }))).ok).toBe(false);
      expect((await probe(`D3 ${label}: putPage to lg-private`, () => engine.putPage('notes/priv', page('Plain','note'), { sourceId: 'lg-private' }))).ok).toBe(true);
      expect((await probe(`D3 ${label}: softDeletePage notes/plain`, () => engine.softDeletePage('notes/plain', { sourceId: 'default' }))).ok).toBe(true);
      expect((await probe(`D3 ${label}: expireFact on a default fact`, async () => { resetDeny(); const fid = await seedFact('notes/plain','q',null); writeFileSync(join(policyDir, '_excluded-people.md'), mut); return engine.expireFact(fid); })).ok).toBe(true);
      resetDeny();
      await engine.executeRaw(`DELETE FROM pages WHERE slug IN ('notes/plain2','notes/innocuous2','wiki/g-pavlov-kuna-family')`);
      await engine.putPage('notes/plain', page('Plain','note'), { sourceId: 'default', migrationWrite: true });
    }
    await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='lg-private'`, ['/tmp/fable9/does-not-exist']);
    expect((await probe('D3 policy dir missing: putPage wiki/g-pavlov-kuna-family', () => engine.putPage('wiki/g-pavlov-kuna-family', page('G Pavlov Kuna Family','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('D3 policy dir missing: putPage notes/plain3 ordinary', () => engine.putPage('notes/plain3', page('Plain','note'), { sourceId: 'default' }))).ok).toBe(false);
    expect((await probe('D3 policy dir missing: softDeletePage notes/plain', () => engine.softDeletePage('notes/plain', { sourceId: 'default' }))).ok).toBe(true);
    await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='lg-private'`, [policyDir]);
    console.log('DONE');
  }, 120_000);
});

describe('Fable round 9 chain.ts', () => {
  test('a refused remember does not reach disk and forget does not republish it', async () => {
    const localPolicyDir = mkdtempSync(join(tmpdir(), 'fable9-chain-policy-'));
    const localBrainDir = mkdtempSync(join(tmpdir(), 'fable9-chain-brain-'));
    const previousAllowlist = process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH;
    process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = join(localPolicyDir, 'allow.tsv');
    writeFileSync(process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH, '');
    copyFileSync('/Users/lg/gbrain-private/_excluded-people.md', join(localPolicyDir, '_excluded-people.md'));
    copyFileSync('/Users/lg/gbrain-private/_brain-filing-rules.md', join(localPolicyDir, '_brain-filing-rules.md'));
    const chain = new PGLiteEngine();
    await chain.connect({});
    await chain.initSchema();
    await chain.executeRaw(`UPDATE sources SET local_path=$1, config = jsonb_set(jsonb_set(COALESCE(config,'{}'::jsonb),'{federated}','true'::jsonb),'{facts_visibility}','"world"'::jsonb) WHERE id='default'`, [localBrainDir]);
    await chain.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('lg-private','LG private',$1,'{}'::jsonb)`, [localPolicyDir]);
    const slug = 'wiki/albert-bausch';
    const body = `# Albert Bausch\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Albert lives in Spain | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->\n`;
    await chain.putPage(slug, { type: 'person', title: 'Albert Bausch', compiled_truth: body, timeline: '', frontmatter: {}, source_path: `${slug}.md` } as any, { sourceId: 'default', migrationWrite: true });
    mkdirSync(join(localBrainDir, 'wiki'), { recursive: true });
    writeFileSync(join(localBrainDir, `${slug}.md`), body);
    const [{ id: oldId }] = await chain.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, source) VALUES ('default',$1,$1,1,'Albert lives in Spain','fact','world','p') RETURNING id`, [slug]);
    try {
      await writeSingleFact(chain, 'default', { fact: 'REFUSED-SECRET: Albert was hospitalised in Malaga in August 2026', entity: slug, visibility: 'world' } as any);
    } catch (e) { console.log('step1 writeSingleFact THREW:', String(e).slice(0, 200)); }
    console.log('step1 DB body has REFUSED-SECRET?', (await chain.getPage(slug, { sourceId: 'default' }))?.compiled_truth?.includes('REFUSED-SECRET'));
    console.log('step1 FILE in default tree has REFUSED-SECRET?', readFileSync(join(localBrainDir, `${slug}.md`), 'utf8').includes('REFUSED-SECRET'));
    expect(readFileSync(join(localBrainDir, `${slug}.md`), 'utf8')).not.toContain('REFUSED-SECRET');
    console.log('step2 forget_fact op:', await operationsByName.forget_fact.handler({ engine: chain, config: {}, logger: { info(){}, warn(){}, error(){} }, dryRun: false, remote: false, sourceId: 'default' } as any, { id: Number(oldId), reason: 'leak cleanup' }));
    const after = (await chain.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '';
    console.log('step2 default DB body now contains REFUSED-SECRET?', after.includes('REFUSED-SECRET'));
    console.log('step2 default DB body:', after);
    expect(after).not.toContain('REFUSED-SECRET');
    expect(readFileSync(join(localBrainDir, `${slug}.md`), 'utf8')).not.toContain('REFUSED-SECRET');
    await chain.disconnect();
    process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = previousAllowlist;
    rmSync(localPolicyDir, { recursive: true, force: true });
    rmSync(localBrainDir, { recursive: true, force: true });
  }, 120_000);
});
