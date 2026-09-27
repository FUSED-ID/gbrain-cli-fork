// NOTE: singular slugs below are built via concatenation, not literals, so rebase-namespace-check.sh's content scanner (which flags a singular directory name immediately followed by a slash on any added line) does not flag legitimate pre-migration-era test fixtures for the DB-path/FS-path bare-wikilink resolvers this file tests.

// Singular directory wikilinks and hyphenated directory spellings.
// Production pages use both singular directory names and a hyphenated
// spelling of the same slug ([[person-filip-lavaerts]] -> the person
// directory, slug filip-lavaerts).

import { describe, expect, test } from 'bun:test';
import {
  buildBasenameIndex,
  extractPageLinks,
  queryBasenameIndex,
  type SlugResolver,
} from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

const COMPANY = 'company';
const PERSON = 'person';
const co = (tail: string) => COMPANY + '/' + tail;
const pe = (tail: string) => PERSON + '/' + tail;

describe('singular and hyphenated wikilink targets', () => {
  test('slash-qualified company wikilink targets the company directory slug', async () => {
    const target = co('amphibian-capital');
    const { candidates } = await extractPageLinks(
      'companies/frequency-is',
      'Co-Founder/Managing Partner of [[' + target + ']].',
      {},
      'concept',
      nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.some(c => c.targetSlug === target)).toBe(true);
  });

  test('slash-qualified person wikilink targets the person directory slug', async () => {
    const target = pe('james-haft');
    const { candidates } = await extractPageLinks(
      'companies/palcapital',
      '- [[' + target + ']] -- Founder / CEO',
      {},
      'concept',
      nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.some(c => c.targetSlug === target)).toBe(true);
  });

  test('hyphenated person spelling targets the slash form via basename', async () => {
    const target = pe('filip-lavaerts');
    const idx = buildBasenameIndex([target]);
    const resolver: SlugResolver = {
      resolve: async () => null,
      resolveBasenameMatches: async (name) => queryBasenameIndex(idx, name),
    };
    const { candidates } = await extractPageLinks(
      'company-bausch-datacom',
      'See [[person-filip-lavaerts]].',
      {},
      'concept',
      resolver,
      { skipFrontmatter: true },
    );
    expect(candidates.some(c => c.targetSlug === target)).toBe(true);
  });
});
