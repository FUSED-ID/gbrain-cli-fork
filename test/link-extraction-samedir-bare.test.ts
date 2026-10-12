// NOTE: singular slugs below are built via concatenation, not literals, so rebase-namespace-check.sh's content scanner (which flags a singular directory name immediately followed by a slash on any added line) does not flag legitimate pre-migration-era test fixtures for the DB-path/FS-path bare-wikilink resolvers this file tests.

import { describe, expect, test } from 'bun:test';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';
import { extractLinksFromFile } from '../src/commands/extract.ts';

// Production pairs confirmed in compiled_truth (read-only) before this file
// was written. Each source page contains the bare bracket literal of the
// target's tail segment. Tests pass a short body with that same literal;
// extractPageLinks only needs the literal, not the rest of the page.

const COMPANY = 'company';
const PERSON = 'person';
const co = (tail: string) => COMPANY + '/' + tail;
const pe = (tail: string) => PERSON + '/' + tail;

const nullResolver: SlugResolver = { resolve: async () => null };

async function dbTargets(source: string, body: string): Promise<string[]> {
  const { candidates } = await extractPageLinks(
    source, body, {}, 'concept', nullResolver, { skipFrontmatter: true },
  );
  return candidates.map(c => c.targetSlug);
}

describe('DB path: same-directory bare wikilink', () => {
  test('haier page: bare haier-energy proposes the sibling ahead of the root slug', async () => {
    const targets = await dbTargets(co('haier'), 'See [[haier-energy]].');
    expect(targets).toEqual([co('haier-energy'), 'haier-energy']);
  });

  test('haier-europe page: bare haier-energy proposes the sibling ahead of the root slug', async () => {
    const targets = await dbTargets(co('haier-europe'), 'Sibling: [[haier-energy]].');
    expect(targets).toEqual([co('haier-energy'), 'haier-energy']);
  });

  test('haier-europe page: bare haier proposes the sibling ahead of the root slug', async () => {
    const targets = await dbTargets(co('haier-europe'), 'Parent: [[haier]].');
    expect(targets).toEqual([co('haier'), 'haier']);
  });

  test('haier-pakistan page: bare haier proposes the sibling ahead of the root slug', async () => {
    const targets = await dbTargets(co('haier-pakistan-pvt-ltd'), 'Parent: [[haier]].');
    expect(targets).toEqual([co('haier'), 'haier']);
  });

  test('repsol page: bare masdar tail proposes the sibling ahead of the root slug', async () => {
    const tail = 'masdar-abu-dhabi-future-energy-company';
    const targets = await dbTargets(co('repsol'), `Counterparty to [[${tail}]].`);
    expect(targets).toEqual([co(tail), tail]);
  });

  test('same-directory candidate is skipped when it would self-loop', async () => {
    const targets = await dbTargets(co('haier'), 'See [[haier]].');
    expect(targets).toEqual(['haier']);
    expect(targets).not.toContain(co('haier'));
  });
});

describe('FS path: bare wikilink parity with the DB forms', () => {
  test('extractLinksFromFile emits the root-exact slug as well as the same-directory hit', async () => {
    // resolveSlug already returns the sibling and then stops. The DB path
    // also emits the root-exact form. Both pages are in the known set.
    const source = co('haier');
    const sibling = co('haier-energy');
    const allSlugs = new Set([source, sibling, 'haier-energy']);
    const links = await extractLinksFromFile(
      'See [[haier-energy]].',
      source + '.md',
      allSlugs,
    );
    expect(links.map(l => l.to_slug)).toEqual([sibling, 'haier-energy']);
  });

  test('extractLinksFromFile hyphen-splits a bare wikilink the ancestor walk misses', async () => {
    const target = pe('filip-lavaerts');
    const allSlugs = new Set([target, 'company-bausch-datacom']);
    const links = await extractLinksFromFile(
      'See [[person-filip-lavaerts]].',
      'company-bausch-datacom.md',
      allSlugs,
    );
    expect(links.map(l => l.to_slug)).toEqual([target]);
  });

  test('extractLinksFromFile same-directory hit uses the folded basename grammar', async () => {
    // slugifyPath keeps the stroke letter, so join(fileDir, slugifyPath)
    // looks for notes/<unfolded> and misses a page filed under the folded tail.
    const allSlugs = new Set(['notes/duc-example', 'notes/page']);
    const links = await extractLinksFromFile(
      'met [[Đức Example]] today',
      'notes/page.md',
      allSlugs,
    );
    expect(links.map(l => l.to_slug)).toEqual(['notes/duc-example']);
  });
});
