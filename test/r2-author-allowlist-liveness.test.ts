/**
 * R2, measured. The register says the two `chris-hooper/_author` allowlist rows
 * are DEAD: that they pass because normalizeSlugish turns `/_author` into
 * `/-author` so rule (b) never fires, not because the allowlist exempts them.
 *
 * candidateKeys ALSO calls stripAuthorSuffix, which adds the bare
 * `chris-hooper` key un-mangled, and lg-private holds a live page at exactly
 * that slug (id 302793). So the claim needs measuring, not documenting.
 *
 * Method: run the same slug twice against the same engine, once with the
 * allowlist row present and once with it absent. If the resolved target is the
 * same both times, the row does nothing and is dead. If it differs, the row is
 * load-bearing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolvePrivateWriteSource } from '../src/core/private-source-routing.ts';

function policyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-r2-'));
  writeFileSync(join(dir, '_brain-filing-rules.md'), '# private filing rules\n');
  writeFileSync(join(dir, '_excluded-people.md'), `# Excluded People

## Family deny-list

| Slug pattern | Name | Relationship | DOB |
|---|---|---|---|
| \`julie-anne-vandenberg\` | Julie Anne Vandenberg | Spouse | - |
`);
  return dir;
}

/** lg-private holds a live page at the bare slug, which is the real shape. */
function fakeEngine(dir: string, privatePages: string[]): BrainEngine {
  const live = new Set(privatePages);
  return {
    executeRaw: async () => [
      { id: 'default', name: 'Default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      { id: 'lg-private', name: 'Private', local_path: dir, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
    ],
    getPage: async (slug: string) => (live.has(slug) ? { id: 302793, slug } : null),
  } as unknown as BrainEngine;
}

function setAllowlist(rows: string[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-r2-allow-'));
  const file = join(dir, 'privacy-allowlist.tsv');
  writeFileSync(file, `# fixture\n${rows.join('\n')}\n`);
  process.env.GBRAIN_PRIVACY_ALLOWLIST_PATH = file;
}

async function routeFor(engine: BrainEngine, slug: string) {
  return resolvePrivateWriteSource(engine, { requestedSourceId: 'default', slug, entityType: 'person' });
}

describe('R2 — are the chris-hooper/_author allowlist rows load-bearing', () => {
  test('MEASUREMENT: same slug, allowlist row present vs absent', async () => {
    const dir = policyDir();
    // The real estate shape: a live lg-private page at the BARE slug.
    const engine = fakeEngine(dir, ['chris-hooper']);

    setAllowlist(['collision|chris-hooper/_author', 'collision|wiki/chris-hooper/_author']);
    const withRow = await routeFor(engine, 'chris-hooper/_author');
    const withRowWiki = await routeFor(engine, 'wiki/chris-hooper/_author');

    setAllowlist(['collision|person/lgv']); // rows removed
    const withoutRow = await routeFor(engine, 'chris-hooper/_author');
    const withoutRowWiki = await routeFor(engine, 'wiki/chris-hooper/_author');

    console.log(`R2 withRow=${JSON.stringify(withRow)}`);
    console.log(`R2 withoutRow=${JSON.stringify(withoutRow)}`);
    console.log(`R2 withRowWiki=${JSON.stringify(withRowWiki)}`);
    console.log(`R2 withoutRowWiki=${JSON.stringify(withoutRowWiki)}`);

    // Whatever the answer, record it explicitly rather than asserting the
    // register's version of it.
    const deadBare = withRow.sourceId === withoutRow.sourceId;
    const deadWiki = withRowWiki.sourceId === withoutRowWiki.sourceId;
    console.log(`R2 VERDICT: bare row dead=${deadBare}, wiki row dead=${deadWiki}`);
    expect(typeof deadBare).toBe('boolean');
  });

  test('MEASUREMENT: does rule (b) fire at all on an /_author slug', async () => {
    const dir = policyDir();
    setAllowlist([]); // no exemptions whatsoever
    const withBarePage = await routeFor(fakeEngine(dir, ['chris-hooper']), 'chris-hooper/_author');
    const withMangledPage = await routeFor(fakeEngine(dir, ['chris-hooper/-author']), 'chris-hooper/_author');
    const withNoPage = await routeFor(fakeEngine(dir, []), 'chris-hooper/_author');
    console.log(`R2 ruleB barePageLive=${JSON.stringify(withBarePage)}`);
    console.log(`R2 ruleB mangledPageLive=${JSON.stringify(withMangledPage)}`);
    console.log(`R2 ruleB noPage=${JSON.stringify(withNoPage)}`);
    expect(withNoPage.routed).toBe(false);
  });
});
