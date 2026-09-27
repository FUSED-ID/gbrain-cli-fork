// Singular directory wikilinks and hyphenated directory spellings.
// Production pages use both company/person (singular) and a hyphenated
// spelling of the same slug ([[person-filip-lavaerts]] -> person/filip-lavaerts).

import { describe, expect, test } from 'bun:test';
import {
  buildBasenameIndex,
  extractPageLinks,
  queryBasenameIndex,
  type SlugResolver,
} from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

describe('singular and hyphenated wikilink targets', () => {
  test('[[company/amphibian-capital]] targets company/amphibian-capital', async () => {
    const { candidates } = await extractPageLinks(
      'companies/frequency-is',
      'Co-Founder/Managing Partner of [[company/amphibian-capital]].',
      {},
      'concept',
      nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.some(c => c.targetSlug === 'company/amphibian-capital')).toBe(true);
  });

  test('[[person/james-haft]] targets person/james-haft', async () => {
    const { candidates } = await extractPageLinks(
      'companies/palcapital',
      '- [[person/james-haft]] -- Founder / CEO',
      {},
      'concept',
      nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.some(c => c.targetSlug === 'person/james-haft')).toBe(true);
  });

  test('[[person-filip-lavaerts]] targets person/filip-lavaerts via basename', async () => {
    const idx = buildBasenameIndex(['person/filip-lavaerts']);
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
    expect(candidates.some(c => c.targetSlug === 'person/filip-lavaerts')).toBe(true);
  });
});
